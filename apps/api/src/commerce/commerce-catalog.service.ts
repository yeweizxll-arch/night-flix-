import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  CatalogMutationMetadata,
  CreateMembershipPlanInput,
  CreatePointsTopupPackageInput,
  ReplaceCatalogTranslationsInput,
  UpsertContentPriceInput,
  UpsertContentPointPriceInput,
  UpsertPriceInput,
  UpdateCatalogStatusInput,
} from './commerce.types';
import {
  amountNumber,
  isUniqueViolation,
  requireCode,
  requireCurrency,
  requireNonNegativeSafeInteger,
  requirePositiveSafeInteger,
  requireStatus,
  requireTranslations,
  requireUuid,
} from './commerce-validation';

@Injectable()
export class CommerceCatalogService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async listTenantCatalog(tenantId: string) {
    requireUuid(tenantId, 'tenantId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const plans = await transaction<Array<{
        code: string;
        duration_days: number;
        id: string;
        prices: Array<{ amountMinor: string | number; currency: string; status: string }>;
        status: string;
        translations: unknown[];
        version: number;
      }>>`
        select
          plan.id,
          plan.code::text as code,
          plan.duration_days,
          plan.status,
          plan.version,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'locale', translation.locale,
              'name', translation.name,
              'description', translation.description
            ) order by translation.locale)
            from membership_plan_translations as translation
            where translation.plan_id = plan.id
          ), '[]'::jsonb) as translations,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'currency', price.currency,
              'amountMinor', price.amount_minor,
              'status', price.status
            ) order by price.currency)
            from membership_plan_prices as price
            where price.plan_id = plan.id
          ), '[]'::jsonb) as prices
        from membership_plans as plan
        where plan.tenant_id = ${tenantId}
        order by plan.created_at desc, plan.id desc
      `;
      const contentPrices = await transaction<Array<{
        amount_minor: string | number;
        currency: string;
        id: string;
        status: string;
        target_id: string;
        target_type: string;
        version: number;
      }>>`
        select id, target_type, target_id, currency, amount_minor, status, version
        from content_prices
        where tenant_id = ${tenantId}
        order by target_type, target_id, currency
      `;
      const contentPointPrices = await transaction<Array<{
        id: string;
        points_amount: string | number | bigint;
        status: string;
        target_id: string;
        target_type: string;
        version: number;
      }>>`
        select id, target_type, target_id, points_amount, status, version
        from content_point_prices
        where tenant_id = ${tenantId}
        order by target_type, target_id
      `;
      const topups = await transaction<Array<{
        bonus_points: string | number;
        code: string;
        id: string;
        points_amount: string | number;
        prices: Array<{ amountMinor: string | number; currency: string; status: string }>;
        status: string;
        translations: unknown[];
        version: number;
      }>>`
        select
          package.id,
          package.code::text as code,
          package.points_amount,
          package.bonus_points,
          package.status,
          package.version,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'locale', translation.locale,
              'name', translation.name,
              'description', translation.description
            ) order by translation.locale)
            from points_topup_package_translations as translation
            where translation.package_id = package.id
          ), '[]'::jsonb) as translations,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'currency', price.currency,
              'amountMinor', price.amount_minor,
              'status', price.status
            ) order by price.currency)
            from points_topup_package_prices as price
            where price.package_id = package.id
          ), '[]'::jsonb) as prices
        from points_topup_packages as package
        where package.tenant_id = ${tenantId}
        order by package.created_at desc, package.id desc
      `;
      return {
        contentPointPrices: contentPointPrices.map((price) => ({
          id: price.id,
          pointsAmount: amountNumber(price.points_amount),
          status: price.status,
          targetId: price.target_id,
          targetType: price.target_type,
          version: price.version,
        })),
        contentPrices: contentPrices.map((price) => ({
          amountMinor: amountNumber(price.amount_minor),
          currency: price.currency,
          id: price.id,
          status: price.status,
          targetId: price.target_id,
          targetType: price.target_type,
          version: price.version,
        })),
        membershipPlans: plans.map((plan) => ({
          code: plan.code,
          durationDays: plan.duration_days,
          id: plan.id,
          prices: plan.prices.map((price) => ({
            ...price,
            amountMinor: amountNumber(price.amountMinor),
          })),
          status: plan.status,
          translations: plan.translations,
          version: plan.version,
        })),
        pointsTopupPackages: topups.map((topup) => ({
          bonusPoints: amountNumber(topup.bonus_points),
          code: topup.code,
          id: topup.id,
          pointsAmount: amountNumber(topup.points_amount),
          prices: topup.prices.map((price) => ({
            ...price,
            amountMinor: amountNumber(price.amountMinor),
          })),
          status: topup.status,
          translations: topup.translations,
          version: topup.version,
        })),
      };
    });
  }

  async createMembershipPlan(
    tenantId: string,
    rawInput: CreateMembershipPlanInput,
    metadata: CatalogMutationMetadata,
  ) {
    requireUuid(tenantId, 'tenantId');
    const code = requireCode(rawInput?.code);
    const durationDays = requirePositiveSafeInteger(rawInput?.durationDays, 'durationDays', 3650);
    const status = requireStatus(rawInput?.status);
    const translations = requireTranslations(rawInput?.translations);
    const id = uuidV7();
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.assertTenantAvailable(transaction, tenantId);
      try {
        await transaction`
          insert into membership_plans (
            id, tenant_id, code, duration_days, status, created_by
          ) values (
            ${id}, ${tenantId}, ${code}, ${durationDays}, ${status}, ${metadata.actorId}
          )
        `;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException('Membership plan code exists');
        throw error;
      }
      for (const translation of translations) {
        await transaction`
          insert into membership_plan_translations (
            id, tenant_id, plan_id, locale, name, description
          ) values (
            ${uuidV7()}, ${tenantId}, ${id}, ${translation.locale},
            ${translation.name}, ${translation.description ?? ''}
          )
        `;
      }
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'commerce.catalog.membership.create',
        after: { code, durationDays, status, translations },
        resourceId: id,
        resourceType: 'membership_plan',
      });
      return { code, durationDays, id, status, translations, version: 0 };
    });
  }

  async upsertMembershipPlanPrice(
    tenantId: string,
    planId: string,
    rawInput: UpsertPriceInput,
    metadata: CatalogMutationMetadata,
  ) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(planId, 'planId');
    const input = validatePrice(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.assertTenantAvailable(transaction, tenantId);
      const rows = await transaction<{ id: string }[]>`
        select id from membership_plans
        where id = ${planId} and tenant_id = ${tenantId}
        for update
      `;
      if (!rows[0]) throw new NotFoundException('Membership plan not found');
      await transaction`
        insert into membership_plan_prices (
          tenant_id, plan_id, currency, amount_minor, status, created_by, updated_by
        ) values (
          ${tenantId}, ${planId}, ${input.currency}, ${input.amountMinor},
          ${input.status}, ${metadata.actorId}, ${metadata.actorId}
        )
        on conflict (plan_id, currency) do update
        set
          amount_minor = excluded.amount_minor,
          status = excluded.status,
          version = membership_plan_prices.version + 1,
          updated_by = excluded.updated_by
      `;
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'commerce.catalog.membership_price.upsert',
        after: input,
        resourceId: planId,
        resourceType: 'membership_plan',
      });
      return { planId, ...input };
    });
  }

  async replaceMembershipPlanTranslations(
    tenantId: string,
    planId: string,
    rawInput: ReplaceCatalogTranslationsInput,
    metadata: CatalogMutationMetadata,
  ) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(planId, 'planId');
    const translations = requireTranslations(rawInput?.translations);
    const version = requireNonNegativeSafeInteger(rawInput?.version, 'version', 1_000_000_000);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.assertTenantAvailable(transaction, tenantId);
      const updated = await transaction<Array<{ version: number }>>`
        update membership_plans
        set version = version + 1, updated_by = ${metadata.actorId}
        where id = ${planId} and tenant_id = ${tenantId} and version = ${version}
        returning version
      `;
      if (!updated[0]) throw new ConflictException('Membership plan has changed');
      await transaction`
        delete from membership_plan_translations
        where plan_id = ${planId} and tenant_id = ${tenantId}
      `;
      for (const translation of translations) {
        await transaction`
          insert into membership_plan_translations (
            id, tenant_id, plan_id, locale, name, description
          ) values (
            ${uuidV7()}, ${tenantId}, ${planId}, ${translation.locale},
            ${translation.name}, ${translation.description ?? ''}
          )
        `;
      }
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'commerce.catalog.membership.translations.replace',
        after: { translations, version: updated[0].version },
        resourceId: planId,
        resourceType: 'membership_plan',
      });
      return { id: planId, translations, version: updated[0].version };
    });
  }

  async updateMembershipPlanStatus(
    tenantId: string,
    planId: string,
    rawInput: UpdateCatalogStatusInput,
    metadata: CatalogMutationMetadata,
  ) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(planId, 'planId');
    if (rawInput?.status === undefined) throw new BadRequestException('status is required');
    const status = requireStatus(rawInput?.status);
    const version = requireNonNegativeSafeInteger(rawInput?.version, 'version', 1_000_000_000);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.assertTenantAvailable(transaction, tenantId);
      const rows = await transaction<Array<{ version: number }>>`
        update membership_plans
        set
          status = ${status},
          version = version + 1,
          updated_by = ${metadata.actorId}
        where id = ${planId}
          and tenant_id = ${tenantId}
          and version = ${version}
        returning version
      `;
      if (!rows[0]) throw new ConflictException('Membership plan has changed');
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'commerce.catalog.membership.status',
        after: { status, version: rows[0].version },
        resourceId: planId,
        resourceType: 'membership_plan',
      });
      return { id: planId, status, version: rows[0].version };
    });
  }

  async upsertContentPrice(
    tenantId: string,
    rawInput: UpsertContentPriceInput,
    metadata: CatalogMutationMetadata,
  ) {
    requireUuid(tenantId, 'tenantId');
    const targetId = requireUuid(rawInput?.targetId, 'targetId');
    if (rawInput?.targetType !== 'drama' && rawInput?.targetType !== 'episode') {
      throw new BadRequestException('targetType is invalid');
    }
    const targetType = rawInput.targetType;
    const input = validatePrice(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.assertTenantAvailable(transaction, tenantId);
      const target = targetType === 'drama'
        ? await transaction<{ id: string }[]>`
            select drama.id
            from dramas as drama
            where drama.id = ${targetId}
              and drama.status = 'published'
              and drama.deleted_at is null
              and (
                (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId})
                or (drama.owner_type = 'platform' and app.tenant_has_drama_license(drama.id))
              )
          `
        : await transaction<{ id: string }[]>`
            select episode.id
            from episodes as episode
            inner join dramas as drama on drama.id = episode.drama_id
            where episode.id = ${targetId}
              and episode.status = 'published'
              and episode.deleted_at is null
              and drama.status = 'published'
              and drama.deleted_at is null
              and (
                (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId})
                or (drama.owner_type = 'platform' and app.tenant_has_drama_license(drama.id))
              )
          `;
      if (!target[0]) throw new BadRequestException('Content is not published or licensed');
      const id = uuidV7();
      const saved = await transaction<{ id: string }[]>`
        insert into content_prices (
          id, tenant_id, target_type, target_id, currency,
          amount_minor, status, created_by, updated_by
        ) values (
          ${id}, ${tenantId}, ${targetType}, ${targetId}, ${input.currency},
          ${input.amountMinor}, ${input.status}, ${metadata.actorId}, ${metadata.actorId}
        )
        on conflict (tenant_id, target_type, target_id, currency) do update
        set
          amount_minor = excluded.amount_minor,
          status = excluded.status,
          version = content_prices.version + 1,
          updated_by = excluded.updated_by
        returning id
      `;
      const priceId = saved[0]?.id ?? id;
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'commerce.catalog.content_price.upsert',
        after: { ...input, targetId, targetType },
        resourceId: priceId,
        resourceType: 'content_price',
      });
      return { id: priceId, targetId, targetType, ...input };
    });
  }

  async upsertContentPointPrice(
    tenantId: string,
    rawInput: UpsertContentPointPriceInput,
    metadata: CatalogMutationMetadata,
  ) {
    requireUuid(tenantId, 'tenantId');
    const targetId = requireUuid(rawInput?.targetId, 'targetId');
    if (rawInput?.targetType !== 'drama' && rawInput?.targetType !== 'episode') {
      throw new BadRequestException('targetType is invalid');
    }
    const targetType = rawInput.targetType;
    const pointsAmount = requirePositiveSafeInteger(rawInput?.pointsAmount, 'pointsAmount');
    const status = requireStatus(rawInput?.status);
    const version = requireNonNegativeSafeInteger(rawInput?.version, 'version', 1_000_000_000);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.assertTenantAvailable(transaction, tenantId);
      await this.lockSellablePointTarget(transaction, tenantId, targetType, targetId);
      const id = uuidV7();
      const rows = await transaction<Array<{ id: string; version: number }>>`
        insert into content_point_prices (
          id, tenant_id, target_type, target_id, points_amount, status,
          created_by, updated_by
        ) values (
          ${id}, ${tenantId}, ${targetType}, ${targetId}, ${pointsAmount}, ${status},
          ${metadata.actorId}, ${metadata.actorId}
        )
        on conflict (tenant_id, target_type, target_id) do update
        set points_amount = excluded.points_amount,
          status = excluded.status,
          version = content_point_prices.version + 1,
          updated_by = excluded.updated_by
        where content_point_prices.version = ${version}
        returning id, version
      `;
      const saved = rows[0];
      if (!saved) throw new ConflictException('Content point price has changed');
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'commerce.catalog.content_point_price.upsert',
        after: { pointsAmount, status, targetId, targetType, version: saved.version },
        resourceId: saved.id,
        resourceType: 'content_point_price',
      });
      return {
        id: saved.id,
        pointsAmount,
        status,
        targetId,
        targetType,
        version: saved.version,
      };
    });
  }

  async createPointsTopupPackage(
    tenantId: string,
    rawInput: CreatePointsTopupPackageInput,
    metadata: CatalogMutationMetadata,
  ) {
    requireUuid(tenantId, 'tenantId');
    const code = requireCode(rawInput?.code);
    const pointsAmount = requirePositiveSafeInteger(rawInput?.pointsAmount, 'pointsAmount');
    const bonusPoints = requireNonNegativeSafeInteger(rawInput?.bonusPoints ?? 0, 'bonusPoints');
    if (pointsAmount > 9_000_000_000_000_000 - bonusPoints) {
      throw new BadRequestException('points total is too large');
    }
    const status = requireStatus(rawInput?.status);
    const translations = requireTranslations(rawInput?.translations);
    const id = uuidV7();
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.assertTenantAvailable(transaction, tenantId);
      try {
        await transaction`
          insert into points_topup_packages (
            id, tenant_id, code, points_amount, bonus_points, status, created_by
          ) values (
            ${id}, ${tenantId}, ${code}, ${pointsAmount}, ${bonusPoints},
            ${status}, ${metadata.actorId}
          )
        `;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException('Points package code exists');
        throw error;
      }
      for (const translation of translations) {
        await transaction`
          insert into points_topup_package_translations (
            id, tenant_id, package_id, locale, name, description
          ) values (
            ${uuidV7()}, ${tenantId}, ${id}, ${translation.locale},
            ${translation.name}, ${translation.description ?? ''}
          )
        `;
      }
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'commerce.catalog.points_package.create',
        after: { bonusPoints, code, pointsAmount, status, translations },
        resourceId: id,
        resourceType: 'points_topup_package',
      });
      return { bonusPoints, code, id, pointsAmount, status, translations, version: 0 };
    });
  }

  async upsertPointsTopupPackagePrice(
    tenantId: string,
    packageId: string,
    rawInput: UpsertPriceInput,
    metadata: CatalogMutationMetadata,
  ) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(packageId, 'packageId');
    const input = validatePrice(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.assertTenantAvailable(transaction, tenantId);
      const rows = await transaction<{ id: string }[]>`
        select id from points_topup_packages
        where id = ${packageId} and tenant_id = ${tenantId}
        for update
      `;
      if (!rows[0]) throw new NotFoundException('Points package not found');
      await transaction`
        insert into points_topup_package_prices (
          tenant_id, package_id, currency, amount_minor,
          status, created_by, updated_by
        ) values (
          ${tenantId}, ${packageId}, ${input.currency}, ${input.amountMinor},
          ${input.status}, ${metadata.actorId}, ${metadata.actorId}
        )
        on conflict (package_id, currency) do update
        set
          amount_minor = excluded.amount_minor,
          status = excluded.status,
          version = points_topup_package_prices.version + 1,
          updated_by = excluded.updated_by
      `;
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'commerce.catalog.points_price.upsert',
        after: input,
        resourceId: packageId,
        resourceType: 'points_topup_package',
      });
      return { packageId, ...input };
    });
  }

  async replacePointsTopupPackageTranslations(
    tenantId: string,
    packageId: string,
    rawInput: ReplaceCatalogTranslationsInput,
    metadata: CatalogMutationMetadata,
  ) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(packageId, 'packageId');
    const translations = requireTranslations(rawInput?.translations);
    const version = requireNonNegativeSafeInteger(rawInput?.version, 'version', 1_000_000_000);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.assertTenantAvailable(transaction, tenantId);
      const updated = await transaction<Array<{ version: number }>>`
        update points_topup_packages
        set version = version + 1, updated_by = ${metadata.actorId}
        where id = ${packageId} and tenant_id = ${tenantId} and version = ${version}
        returning version
      `;
      if (!updated[0]) throw new ConflictException('Points package has changed');
      await transaction`
        delete from points_topup_package_translations
        where package_id = ${packageId} and tenant_id = ${tenantId}
      `;
      for (const translation of translations) {
        await transaction`
          insert into points_topup_package_translations (
            id, tenant_id, package_id, locale, name, description
          ) values (
            ${uuidV7()}, ${tenantId}, ${packageId}, ${translation.locale},
            ${translation.name}, ${translation.description ?? ''}
          )
        `;
      }
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'commerce.catalog.points_package.translations.replace',
        after: { translations, version: updated[0].version },
        resourceId: packageId,
        resourceType: 'points_topup_package',
      });
      return { id: packageId, translations, version: updated[0].version };
    });
  }

  async updatePointsTopupPackageStatus(
    tenantId: string,
    packageId: string,
    rawInput: UpdateCatalogStatusInput,
    metadata: CatalogMutationMetadata,
  ) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(packageId, 'packageId');
    if (rawInput?.status === undefined) throw new BadRequestException('status is required');
    const status = requireStatus(rawInput?.status);
    const version = requireNonNegativeSafeInteger(rawInput?.version, 'version', 1_000_000_000);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.assertTenantAvailable(transaction, tenantId);
      const rows = await transaction<Array<{ version: number }>>`
        update points_topup_packages
        set
          status = ${status},
          version = version + 1,
          updated_by = ${metadata.actorId}
        where id = ${packageId}
          and tenant_id = ${tenantId}
          and version = ${version}
        returning version
      `;
      if (!rows[0]) throw new ConflictException('Points package has changed');
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'commerce.catalog.points_package.status',
        after: { status, version: rows[0].version },
        resourceId: packageId,
        resourceType: 'points_topup_package',
      });
      return { id: packageId, status, version: rows[0].version };
    });
  }

  private async assertTenantAvailable(
    transaction: DatabaseTransaction,
    tenantId: string,
  ): Promise<void> {
    const rows = await transaction<{ available: boolean }[]>`
      select status = 'active' and expires_at > statement_timestamp() as available
      from tenants where id = ${tenantId}
    `;
    if (!rows[0]?.available) throw new ConflictException('Tenant is not available');
  }

  private async lockSellablePointTarget(
    transaction: DatabaseTransaction,
    tenantId: string,
    targetType: 'drama' | 'episode',
    targetId: string,
  ): Promise<void> {
    const targets = targetType === 'drama'
      ? await transaction<Array<{ drama_id: string; owner_type: 'platform' | 'tenant' }>>`
          select drama.id as drama_id, drama.owner_type
          from dramas as drama
          where drama.id = ${targetId}
            and drama.status = 'published'
            and drama.deleted_at is null
            and (
              (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId})
              or (drama.owner_type = 'platform' and app.tenant_has_drama_license(drama.id))
            )
          for share of drama
        `
      : await transaction<Array<{ drama_id: string; owner_type: 'platform' | 'tenant' }>>`
          select drama.id as drama_id, drama.owner_type
          from episodes as episode
          inner join dramas as drama on drama.id = episode.drama_id
          where episode.id = ${targetId}
            and episode.status = 'published'
            and episode.deleted_at is null
            and drama.status = 'published'
            and drama.deleted_at is null
            and (
              (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId})
              or (drama.owner_type = 'platform' and app.tenant_has_drama_license(drama.id))
            )
          for share of episode, drama
        `;
    const target = targets[0];
    if (!target) throw new BadRequestException('Content is not published or licensed');
    if (target.owner_type === 'platform') {
      const licenses = await transaction<{ id: string }[]>`
        select license.id
        from content_licenses as license
        inner join content_license_items as item
          on item.license_id = license.id and item.tenant_id = license.tenant_id
        where license.tenant_id = ${tenantId}
          and item.drama_id = ${target.drama_id}
          and license.status in ('scheduled', 'active')
          and license.starts_at <= transaction_timestamp()
          and license.expires_at > transaction_timestamp()
        order by license.id limit 1
        for share of license, item
      `;
      if (!licenses[0]) throw new BadRequestException('Content is not published or licensed');
    }
  }

  private async insertAudit(
    transaction: DatabaseTransaction,
    tenantId: string,
    metadata: CatalogMutationMetadata,
    input: { action: string; after: object; resourceId: string; resourceType: string },
  ): Promise<void> {
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, request_id
      ) values (
        ${uuidV7()}, 'tenant', ${tenantId}, 'tenant_staff', ${metadata.actorId},
        ${input.action}, ${input.resourceType}, ${input.resourceId},
        ${transaction.json(toJsonValue(input.after))}, ${metadata.requestId}
      )
    `;
  }
}

function validatePrice(input: UpsertPriceInput) {
  return {
    amountMinor: requirePositiveSafeInteger(input?.amountMinor, 'amountMinor'),
    currency: requireCurrency(input?.currency),
    status: requireStatus(input?.status),
  };
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
