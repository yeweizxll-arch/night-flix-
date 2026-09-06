import { lockPublicDistribution } from '../public-drama-pool/public-distribution';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  CommerceCustomerPrincipal,
  CommerceOrderInput,
  CommerceOrderSummary,
  CommerceProductType,
  CommerceQuote,
  CustomerOrderMetadata,
} from './commerce.types';
import {
  amountNumber,
  requireCurrency,
  requireLocale,
  requireProductType,
  requireUuid,
} from './commerce-validation';

interface ProductRow {
  amount_minor?: string | number | bigint;
  bonus_points?: string | number | bigint;
  drama_id?: string;
  duration_days?: number;
  name: string;
  owner_type?: 'platform' | 'tenant';
  points_amount?: string | number | bigint;
  product_id: string;
}

interface CustomerSnapshotRow {
  email: string | null;
  phone: string | null;
  username: string;
}

interface OrderRow {
  created_at: Date;
  currency: CommerceOrderSummary['currency'];
  expires_at: Date;
  id: string;
  item_type: CommerceProductType;
  order_no: string;
  order_type: CommerceProductType;
  product_id: string;
  product_snapshot_json: CommerceQuote['product'];
  status: CommerceOrderSummary['status'];
  total_minor: string | number | bigint;
  unit_amount_minor: string | number | bigint;
  locale: CommerceOrderSummary['locale'];
}

interface StaffOrderRow extends OrderRow {
  account_id: string;
  cancelled_at: Date | null;
  collection_mode: 'platform_collect' | 'tenant_direct' | null;
  customer_snapshot_json: Record<string, unknown>;
  discount_minor: string | number | bigint;
  paid_at: Date | null;
  refunded_at: Date | null;
  subtotal_minor: string | number | bigint;
  updated_at: Date;
  version: number;
}

interface StaffOrderItemRow {
  created_at: Date;
  currency: CommerceOrderSummary['currency'];
  id: string;
  item_type: CommerceProductType;
  line_no: number;
  product_id: string;
  product_snapshot_json: CommerceQuote['product'];
  quantity: number;
  total_amount_minor: string | number | bigint;
  unit_amount_minor: string | number | bigint;
}

interface CommandRow {
  id: string;
  request_hash: string;
  response_json: CommerceOrderSummary | null;
  status: 'completed' | 'failed' | 'processing';
}

@Injectable()
export class CommerceOrderService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async quote(
    principal: CommerceCustomerPrincipal,
    rawInput: CommerceOrderInput,
  ): Promise<CommerceQuote> {
    const input = validateOrderInput(rawInput);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.lockAvailableCustomer(transaction, principal, false);
      return this.loadQuote(transaction, principal.tenantId, input);
    });
  }

  async createOrder(
    principal: CommerceCustomerPrincipal,
    rawInput: CommerceOrderInput,
    metadata: CustomerOrderMetadata,
  ): Promise<CommerceOrderSummary> {
    const input = validateOrderInput(rawInput);
    const idempotencyKey = requireIdempotencyKey(metadata.idempotencyKey);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      const customer = await this.lockAvailableCustomer(transaction, principal, true);
      const command = await this.beginCommand(
        transaction,
        principal,
        input,
        idempotencyKey,
      );
      if (command.cached) return command.cached;

      const quote = await this.loadQuote(transaction, principal.tenantId, input);
      const orderId = uuidV7();
      const orderNo = `ORD${orderId.replaceAll('-', '').slice(0, 26).toUpperCase()}`;
      const inserted = await transaction<Array<{ created_at: Date; expires_at: Date }>>`
        insert into orders (
          id, tenant_id, account_id, order_no, order_type, currency,
          subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at
        ) values (
          ${orderId}, ${principal.tenantId}, ${principal.accountId}, ${orderNo},
          ${input.productType}, ${quote.currency}, ${quote.totalMinor}, ${quote.totalMinor},
          ${quote.locale}, ${transaction.json({
            accountId: principal.accountId,
            email: customer.email,
            phone: customer.phone,
            username: customer.username,
          })}, date_trunc('second', statement_timestamp()) + interval '60 minutes'
        )
        returning created_at, expires_at
      `;
      const timestamps = inserted[0];
      if (!timestamps) throw new Error('Order was not created');
      await transaction`
        insert into order_items (
          id, tenant_id, order_id, line_no, item_type, product_id,
          quantity, currency, unit_amount_minor, total_amount_minor,
          product_snapshot_json
        ) values (
          ${uuidV7()}, ${principal.tenantId}, ${orderId}, 1, ${input.productType},
          ${input.productId}, 1, ${quote.currency}, ${quote.totalMinor},
          ${quote.totalMinor}, ${transaction.json(toJsonValue(quote.product))}
        )
      `;
      const response: CommerceOrderSummary = {
        createdAt: timestamps.created_at.toISOString(),
        currency: quote.currency,
        expiresAt: timestamps.expires_at.toISOString(),
        id: orderId,
        item: { ...quote.product, unitAmountMinor: quote.totalMinor },
        locale: quote.locale,
        orderNo,
        orderType: input.productType,
        status: 'pending_payment',
        totalMinor: quote.totalMinor,
      };
      await this.insertAudit(transaction, principal, metadata, response);
      await this.insertOutbox(transaction, principal, metadata.requestId, response);
      await transaction`
        update command_idempotency
        set
          status = 'completed',
          response_status = 201,
          response_json = ${transaction.json(toJsonValue(response))},
          resource_type = 'order',
          resource_id = ${orderId},
          locked_at = null
        where id = ${command.id} and status = 'processing'
      `;
      return response;
    });
  }

  async listOrders(
    principal: CommerceCustomerPrincipal,
    pageValue: number,
    pageSizeValue: number,
  ) {
    const page = boundedInteger(pageValue, 1, 1, 10_000);
    const pageSize = boundedInteger(pageSizeValue, 20, 1, 100);
    const offset = (page - 1) * pageSize;
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.lockAvailableCustomer(transaction, principal, false);
      await this.expirePendingOrders(transaction, principal);
      const rows = await transaction<Array<OrderRow & { total_count: number }>>`
        select
          commerce_order.id,
          commerce_order.order_no,
          commerce_order.order_type,
          commerce_order.status,
          commerce_order.currency,
          commerce_order.total_minor,
          commerce_order.locale,
          commerce_order.expires_at,
          commerce_order.created_at,
          item.item_type,
          item.product_id,
          item.unit_amount_minor,
          item.product_snapshot_json,
          count(*) over()::integer as total_count
        from orders as commerce_order
        inner join order_items as item
          on item.order_id = commerce_order.id
          and item.tenant_id = commerce_order.tenant_id
          and item.line_no = 1
        where commerce_order.tenant_id = ${principal.tenantId}
          and commerce_order.account_id = ${principal.accountId}
        order by commerce_order.created_at desc, commerce_order.id desc
        limit ${pageSize} offset ${offset}
      `;
      return {
        items: rows.map(toOrderSummary),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  async getOrder(
    principal: CommerceCustomerPrincipal,
    orderId: string,
  ): Promise<CommerceOrderSummary> {
    requireUuid(orderId, 'orderId');
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.lockAvailableCustomer(transaction, principal, false);
      await this.expirePendingOrders(transaction, principal, orderId);
      const rows = await transaction<OrderRow[]>`
        select
          commerce_order.id,
          commerce_order.order_no,
          commerce_order.order_type,
          commerce_order.status,
          commerce_order.currency,
          commerce_order.total_minor,
          commerce_order.locale,
          commerce_order.expires_at,
          commerce_order.created_at,
          item.item_type,
          item.product_id,
          item.unit_amount_minor,
          item.product_snapshot_json
        from orders as commerce_order
        inner join order_items as item
          on item.order_id = commerce_order.id
          and item.tenant_id = commerce_order.tenant_id
          and item.line_no = 1
        where commerce_order.id = ${orderId}
          and commerce_order.tenant_id = ${principal.tenantId}
          and commerce_order.account_id = ${principal.accountId}
      `;
      if (!rows[0]) throw new NotFoundException('Order not found');
      return toOrderSummary(rows[0]);
    });
  }

  async listTenantOrders(
    tenantId: string,
    rawQuery: {
      orderType?: unknown;
      page?: unknown;
      pageSize?: unknown;
      q?: unknown;
      status?: unknown;
    },
  ) {
    requireUuid(tenantId, 'tenantId');
    const page = boundedInteger(Number(rawQuery.page ?? 1), 1, 1, 10_000);
    const pageSize = boundedInteger(Number(rawQuery.pageSize ?? 20), 20, 1, 100);
    const status = optionalOrderStatus(rawQuery.status);
    const orderType = optionalOrderType(rawQuery.orderType);
    const q = optionalOrderSearch(rawQuery.q);
    const searchPattern = q ? `%${escapeLikePattern(q)}%` : null;
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<Array<StaffOrderRow & { total_count: number }>>`
        select
          commerce_order.id,
          commerce_order.account_id,
          commerce_order.order_no,
          commerce_order.order_type,
          case
            when commerce_order.status = 'pending_payment'
              and commerce_order.expires_at <= statement_timestamp()
            then 'expired'
            else commerce_order.status
          end as status,
          commerce_order.currency,
          commerce_order.subtotal_minor,
          commerce_order.discount_minor,
          commerce_order.total_minor,
          commerce_order.locale,
          commerce_order.customer_snapshot_json,
          commerce_order.expires_at,
          commerce_order.paid_at,
          commerce_order.cancelled_at,
          commerce_order.refunded_at,
          commerce_order.version,
          commerce_order.created_at,
          commerce_order.updated_at,
          (
            select attempt.collection_mode
            from payment_attempts as attempt
            where attempt.tenant_id = commerce_order.tenant_id
              and attempt.order_id = commerce_order.id
              and attempt.status = 'succeeded'
            order by attempt.succeeded_at desc, attempt.id desc
            limit 1
          ) as collection_mode,
          item.item_type,
          item.product_id,
          item.unit_amount_minor,
          item.product_snapshot_json,
          count(*) over()::integer as total_count
        from orders as commerce_order
        inner join order_items as item
          on item.order_id = commerce_order.id
          and item.tenant_id = commerce_order.tenant_id
          and item.line_no = 1
        where commerce_order.tenant_id = ${tenantId}
          and (
            ${status ?? null}::text is null
            or case
              when commerce_order.status = 'pending_payment'
                and commerce_order.expires_at <= statement_timestamp()
              then 'expired'
              else commerce_order.status
            end = ${status ?? null}
          )
          and (${orderType ?? null}::text is null or commerce_order.order_type = ${orderType ?? null})
          and (
            ${searchPattern}::text is null
            or commerce_order.order_no ilike ${searchPattern} escape '!'
            or coalesce(commerce_order.customer_snapshot_json ->> 'username', '')
              ilike ${searchPattern} escape '!'
            or coalesce(commerce_order.customer_snapshot_json ->> 'email', '')
              ilike ${searchPattern} escape '!'
            or coalesce(commerce_order.customer_snapshot_json ->> 'phone', '')
              ilike ${searchPattern} escape '!'
          )
        order by commerce_order.created_at desc, commerce_order.id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map(toStaffOrderSummary),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  async getTenantOrder(tenantId: string, orderId: string) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(orderId, 'orderId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<StaffOrderRow[]>`
        select
          commerce_order.id,
          commerce_order.account_id,
          commerce_order.order_no,
          commerce_order.order_type,
          case
            when commerce_order.status = 'pending_payment'
              and commerce_order.expires_at <= statement_timestamp()
            then 'expired'
            else commerce_order.status
          end as status,
          commerce_order.currency,
          commerce_order.subtotal_minor,
          commerce_order.discount_minor,
          commerce_order.total_minor,
          commerce_order.locale,
          commerce_order.customer_snapshot_json,
          commerce_order.expires_at,
          commerce_order.paid_at,
          commerce_order.cancelled_at,
          commerce_order.refunded_at,
          commerce_order.version,
          commerce_order.created_at,
          commerce_order.updated_at,
          (
            select attempt.collection_mode
            from payment_attempts as attempt
            where attempt.tenant_id = commerce_order.tenant_id
              and attempt.order_id = commerce_order.id
              and attempt.status = 'succeeded'
            order by attempt.succeeded_at desc, attempt.id desc
            limit 1
          ) as collection_mode,
          first_item.item_type,
          first_item.product_id,
          first_item.unit_amount_minor,
          first_item.product_snapshot_json
        from orders as commerce_order
        inner join order_items as first_item
          on first_item.order_id = commerce_order.id
          and first_item.tenant_id = commerce_order.tenant_id
          and first_item.line_no = 1
        where commerce_order.id = ${orderId}
          and commerce_order.tenant_id = ${tenantId}
      `;
      const row = rows[0];
      if (!row) throw new NotFoundException('Order not found');
      const items = await transaction<StaffOrderItemRow[]>`
        select
          id, line_no, item_type, product_id, quantity, currency,
          unit_amount_minor, total_amount_minor, product_snapshot_json, created_at
        from order_items
        where order_id = ${orderId} and tenant_id = ${tenantId}
        order by line_no
      `;
      return {
        ...toStaffOrderSummary(row),
        items: items.map((item) => ({
          createdAt: item.created_at.toISOString(),
          currency: item.currency,
          id: item.id,
          lineNo: item.line_no,
          product: {
            ...item.product_snapshot_json,
            id: item.product_id,
            type: item.item_type,
          },
          quantity: item.quantity,
          totalAmountMinor: amountNumber(item.total_amount_minor),
          unitAmountMinor: amountNumber(item.unit_amount_minor),
        })),
      };
    });
  }

  private async loadQuote(
    transaction: DatabaseTransaction,
    tenantId: string,
    input: ReturnType<typeof validateOrderInput>,
  ): Promise<CommerceQuote> {
    let product: ProductRow | undefined;
    const region = await transaction<{ allowed: boolean }[]>`select app.customer_region_allowed(${tenantId}::uuid, null::uuid) as allowed`;
    if (!region[0]?.allowed) throw new NotFoundException('Purchases are unavailable in this region');
    if (input.productType === 'membership') {
      const products = await transaction<ProductRow[]>`
        select
          plan.id as product_id,
          plan.duration_days,
          coalesce(
            (select translation.name from membership_plan_translations as translation
              where translation.plan_id = plan.id and translation.locale = ${input.locale}),
            (select translation.name from membership_plan_translations as translation
              where translation.plan_id = plan.id and translation.locale = 'en-US'),
            (select translation.name from membership_plan_translations as translation
              where translation.plan_id = plan.id order by translation.locale limit 1)
          ) as name
        from membership_plans as plan
        where plan.id = ${input.productId}
          and plan.tenant_id = ${tenantId}
          and plan.status = 'active'
        for share of plan
      `;
      product = products[0];
      if (product) {
        const prices = await transaction<Array<{ amount_minor: ProductRow['amount_minor'] }>>`
          select price.amount_minor
          from membership_plan_prices as price
          where price.plan_id = ${input.productId}
            and price.tenant_id = ${tenantId}
            and price.currency = ${input.currency}
            and price.status = 'active'
          for share of price
        `;
        product.amount_minor = prices[0]?.amount_minor;
      }
    } else if (input.productType === 'points_topup') {
      const products = await transaction<ProductRow[]>`
        select
          package.id as product_id,
          package.points_amount,
          package.bonus_points,
          coalesce(
            (select translation.name from points_topup_package_translations as translation
              where translation.package_id = package.id and translation.locale = ${input.locale}),
            (select translation.name from points_topup_package_translations as translation
              where translation.package_id = package.id and translation.locale = 'en-US'),
            (select translation.name from points_topup_package_translations as translation
              where translation.package_id = package.id order by translation.locale limit 1)
          ) as name
        from points_topup_packages as package
        where package.id = ${input.productId}
          and package.tenant_id = ${tenantId}
          and package.status = 'active'
        for share of package
      `;
      product = products[0];
      if (product) {
        const prices = await transaction<Array<{ amount_minor: ProductRow['amount_minor'] }>>`
          select price.amount_minor
          from points_topup_package_prices as price
          where price.package_id = ${input.productId}
            and price.tenant_id = ${tenantId}
            and price.currency = ${input.currency}
            and price.status = 'active'
          for share of price
        `;
        product.amount_minor = prices[0]?.amount_minor;
      }
    } else if (input.productType === 'drama') {
      const products = await transaction<ProductRow[]>`
        select
          drama.id as product_id,
          drama.owner_type,
          coalesce(
            (select translation.title from drama_translations as translation
              where translation.drama_id = drama.id and translation.locale = ${input.locale}),
            (select translation.title from drama_translations as translation
              where translation.drama_id = drama.id and translation.locale = 'en-US'),
            (select translation.title from drama_translations as translation
              where translation.drama_id = drama.id order by translation.locale limit 1),
            drama.code::text
          ) as name
        from dramas as drama
        where drama.id = ${input.productId}
          and drama.status = 'published'
          and drama.deleted_at is null
          and drama.emergency_takedown_at is null
          and app.customer_region_allowed(${tenantId}, drama.id)
          and (
            (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId})
            or (drama.owner_type = 'platform' and app.tenant_has_drama_license(drama.id))
          )
        and app.lock_customer_row('dramas', drama.id, to_jsonb(drama.*))
      `;
      product = products[0];
      if (product) {
        const prices = await transaction<Array<{ amount_minor: ProductRow['amount_minor'] }>>`
          select price.amount_minor
          from content_prices as price
          where price.tenant_id = ${tenantId}
            and price.target_type = 'drama'
            and price.target_id = ${input.productId}
            and price.currency = ${input.currency}
            and price.status = 'active'
          for share of price
        `;
        product.amount_minor = prices[0]?.amount_minor;
        if (product.owner_type === 'platform') {
          await this.lockEffectiveContentLicense(transaction, tenantId, input.productId);
        }
      }
    } else {
      const products = await transaction<ProductRow[]>`
        select
          episode.id as product_id,
          episode.drama_id,
          coalesce(
            (select translation.title from episode_translations as translation
              where translation.episode_id = episode.id and translation.locale = ${input.locale}),
            (select translation.title from episode_translations as translation
              where translation.episode_id = episode.id and translation.locale = 'en-US'),
            (select translation.title from episode_translations as translation
              where translation.episode_id = episode.id order by translation.locale limit 1),
            'Episode ' || episode.episode_no::text
          ) as name
        from episodes as episode
        where episode.id = ${input.productId}
          and episode.status = 'published'
          and episode.deleted_at is null
        and app.lock_customer_row('episodes', episode.id, to_jsonb(episode.*))
      `;
      product = products[0];
      if (product?.drama_id) {
        const dramas = await transaction<Array<{ owner_type: 'platform' | 'tenant' }>>`
          select drama.owner_type
          from dramas as drama
          where drama.id = ${product.drama_id}
            and drama.status = 'published'
            and drama.deleted_at is null
          and drama.emergency_takedown_at is null
          and app.customer_region_allowed(${tenantId}, drama.id)
            and (
              (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId})
              or (drama.owner_type = 'platform' and app.tenant_has_drama_license(drama.id))
            )
          and app.lock_customer_row('dramas', drama.id, to_jsonb(drama.*))
        `;
        const drama = dramas[0];
        if (!drama) product = undefined;
        if (product && drama) {
          product.owner_type = drama.owner_type;
          const prices = await transaction<Array<{ amount_minor: ProductRow['amount_minor'] }>>`
            select price.amount_minor
            from content_prices as price
            where price.tenant_id = ${tenantId}
              and price.target_type = 'episode'
              and price.target_id = ${input.productId}
              and price.currency = ${input.currency}
              and price.status = 'active'
            for share of price
          `;
          product.amount_minor = prices[0]?.amount_minor;
          if (product.owner_type === 'platform') {
            if (!product.drama_id) throw new Error('Episode drama binding is missing');
            await this.lockEffectiveContentLicense(transaction, tenantId, product.drama_id);
          }
        }
      }
    }
    if (!product?.name || product.amount_minor === undefined) {
      throw new NotFoundException('Purchasable product or price not found');
    }
    const productSnapshot: CommerceQuote['product'] = {
      id: product.product_id,
      name: product.name,
      type: input.productType,
    };
    if (product.duration_days !== undefined) {
      productSnapshot.durationDays = product.duration_days;
    }
    if (product.drama_id) productSnapshot.dramaId = product.drama_id;
    if (product.points_amount !== undefined) {
      productSnapshot.pointsAmount = amountNumber(product.points_amount);
      productSnapshot.bonusPoints = amountNumber(product.bonus_points ?? 0);
    }
    return {
      currency: input.currency,
      locale: input.locale,
      product: productSnapshot,
      totalMinor: amountNumber(product.amount_minor),
    };
  }

  private async lockAvailableCustomer(
    transaction: DatabaseTransaction,
    principal: CommerceCustomerPrincipal,
    exclusive: boolean,
  ): Promise<CustomerSnapshotRow> {
    const tenants = await transaction<Array<{ id: string }>>`
      select tenant.id
      from tenants as tenant
      where tenant.id = ${principal.tenantId}
        and tenant.status = 'active'
        and tenant.expires_at > statement_timestamp()
        and tenant.user_site_enabled
        and tenant.platform_site_enabled
      for share of tenant
    `;
    if (!tenants[0]) {
      throw new ConflictException('Tenant or customer is not available');
    }
    const customers = exclusive
      ? await transaction<CustomerSnapshotRow[]>`
          select customer.username::text, customer.email::text, customer.phone
          from customer_accounts as customer
          where customer.id = ${principal.accountId}
            and customer.tenant_id = ${principal.tenantId}
            and customer.status = 'active'
          for update of customer
        `
      : await transaction<CustomerSnapshotRow[]>`
          select customer.username::text, customer.email::text, customer.phone
          from customer_accounts as customer
          where customer.id = ${principal.accountId}
            and customer.tenant_id = ${principal.tenantId}
            and customer.status = 'active'
          for share of customer
        `;
    const customer = customers[0];
    if (!customer) throw new ConflictException('Tenant or customer is not available');
    return customer;
  }

  private async lockEffectiveContentLicense(
    transaction: DatabaseTransaction,
    tenantId: string,
    dramaId: string,
  ): Promise<void> {
    await lockPublicDistribution(transaction, tenantId, dramaId);
  }
  private async beginCommand(
    transaction: DatabaseTransaction,
    principal: CommerceCustomerPrincipal,
    input: ReturnType<typeof validateOrderInput>,
    idempotencyKey: string,
  ): Promise<{ cached?: CommerceOrderSummary; id: string }> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify(input))
      .digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
        'customer.commerce.order.create', ${idempotencyKey}, ${requestHash},
        statement_timestamp() + interval '24 hours'
      )
      on conflict do nothing
      returning id
    `;
    if (inserted[0]) return { id };
    const rows = await transaction<CommandRow[]>`
      select id, request_hash, status, response_json
      from command_idempotency
      where scope_type = 'tenant'
        and tenant_id = ${principal.tenantId}
        and actor_type = 'user'
        and actor_id = ${principal.accountId}
        and route_key = 'customer.commerce.order.create'
        and idempotency_key = ${idempotencyKey}
      for update
    `;
    const existing = rows[0];
    if (!existing) throw new ConflictException('Idempotency record is unavailable');
    if (existing.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was used for another order');
    }
    if (existing.status === 'completed' && existing.response_json) {
      return { cached: existing.response_json, id: existing.id };
    }
    throw new ConflictException('The same order is already processing');
  }

  private async expirePendingOrders(
    transaction: DatabaseTransaction,
    principal: CommerceCustomerPrincipal,
    orderId?: string,
  ): Promise<void> {
    await transaction`
      update orders
      set status = 'expired', version = version + 1
      where tenant_id = ${principal.tenantId}
        and account_id = ${principal.accountId}
        and status = 'pending_payment'
        and expires_at <= statement_timestamp()
        and (${orderId ?? null}::uuid is null or id = ${orderId ?? null})
    `;
  }

  private async insertAudit(
    transaction: DatabaseTransaction,
    principal: CommerceCustomerPrincipal,
    metadata: CustomerOrderMetadata,
    response: CommerceOrderSummary,
  ): Promise<void> {
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, ip, request_id
      ) values (
        ${uuidV7()}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
        'commerce.order.create', 'order', ${response.id},
        ${transaction.json(toJsonValue(response))}, ${metadata.ip ?? null}, ${metadata.requestId}
      )
    `;
  }

  private async insertOutbox(
    transaction: DatabaseTransaction,
    principal: CommerceCustomerPrincipal,
    requestId: string,
    response: CommerceOrderSummary,
  ): Promise<void> {
    const eventId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, 'tenant', ${principal.tenantId}, ${`event:${eventId}`},
        ${`${requestId}:order-created`}, 'order', ${response.id},
        'OrderPendingPaymentCreated',
        ${transaction.json({
          accountId: principal.accountId,
          currency: response.currency,
          orderId: response.id,
          tenantId: principal.tenantId,
          totalMinor: response.totalMinor,
        })}
      )
    `;
  }
}

function validateOrderInput(rawInput: CommerceOrderInput) {
  if (!rawInput || typeof rawInput !== 'object') {
    throw new BadRequestException('Body is required');
  }
  const record = rawInput as unknown as Record<string, unknown>;
  const forbiddenMoneyFields = [
    'amount',
    'amountMinor',
    'price',
    'subtotalMinor',
    'total',
    'totalMinor',
    'unitAmountMinor',
  ];
  if (forbiddenMoneyFields.some((field) => Object.hasOwn(record, field))) {
    throw new BadRequestException('Client-provided monetary amounts are not allowed');
  }
  return {
    currency: requireCurrency(record.currency),
    locale: requireLocale(record.locale),
    productId: requireUuid(record.productId, 'productId'),
    productType: requireProductType(record.productType),
  };
}

function requireIdempotencyKey(value: unknown): string {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.trim())
  ) {
    throw new BadRequestException('A valid Idempotency-Key header is required');
  }
  return value.trim();
}

function toOrderSummary(row: OrderRow): CommerceOrderSummary {
  return {
    createdAt: row.created_at.toISOString(),
    currency: row.currency,
    expiresAt: row.expires_at.toISOString(),
    id: row.id,
    item: {
      ...row.product_snapshot_json,
      id: row.product_id,
      type: row.item_type,
      unitAmountMinor: amountNumber(row.unit_amount_minor),
    },
    locale: row.locale,
    orderNo: row.order_no,
    orderType: row.order_type,
    status: row.status,
    totalMinor: amountNumber(row.total_minor),
  };
}

function toStaffOrderSummary(row: StaffOrderRow) {
  return {
    accountId: row.account_id,
    cancelledAt: row.cancelled_at?.toISOString(),
    ...(row.collection_mode ? { collectionMode: row.collection_mode } : {}),
    createdAt: row.created_at.toISOString(),
    currency: row.currency,
    customer: publicCustomerSnapshot(row.customer_snapshot_json),
    discountMinor: amountNumber(row.discount_minor),
    expiresAt: row.expires_at.toISOString(),
    id: row.id,
    item: {
      ...row.product_snapshot_json,
      id: row.product_id,
      type: row.item_type,
      unitAmountMinor: amountNumber(row.unit_amount_minor),
    },
    locale: row.locale,
    orderNo: row.order_no,
    orderType: row.order_type,
    paidAt: row.paid_at?.toISOString(),
    refundedAt: row.refunded_at?.toISOString(),
    status: row.status,
    subtotalMinor: amountNumber(row.subtotal_minor),
    totalMinor: amountNumber(row.total_minor),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

export type StaffOrderResponse = ReturnType<typeof toStaffOrderSummary>;

function publicCustomerSnapshot(value: Record<string, unknown>): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const field of ['accountId', 'email', 'phone', 'username'] as const) {
    const candidate = value[field];
    if (typeof candidate === 'string' && candidate.length <= 320) snapshot[field] = candidate;
  }
  return snapshot;
}

function optionalOrderStatus(value: unknown): CommerceOrderSummary['status'] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!['cancelled', 'expired', 'paid', 'pending_payment', 'refunded'].includes(String(value))) {
    throw new BadRequestException('status is invalid');
  }
  return value as CommerceOrderSummary['status'];
}

function optionalOrderType(value: unknown): CommerceProductType | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireProductType(value);
}

function optionalOrderSearch(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException('q is invalid');
  const result = value.trim();
  if (result.length < 1 || result.length > 100) {
    throw new BadRequestException('q is invalid');
  }
  return result;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[!%_]/g, (character) => `!${character}`);
}

function boundedInteger(
  value: number,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
