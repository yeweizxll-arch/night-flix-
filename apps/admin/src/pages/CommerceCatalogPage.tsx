import { APP_LOCALE_OPTIONS, type AppLocale } from '@drama/contracts';
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  message,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { formatMoney, fractionDigits, parseMajorAmount } from './finance-ui';
import { ContentTargetSelect } from './ContentTargetSelect';

type CatalogStatus = 'active' | 'disabled';
type Currency = 'CNY' | 'USD' | 'EUR' | 'JPY' | 'KRW';
type Locale = AppLocale;

interface Translation {
  description?: string;
  locale: Locale;
  name: string;
}

interface Price {
  amountMinor: number;
  currency: Currency;
  status: CatalogStatus;
}

interface MembershipPlan {
  code: string;
  durationDays: number;
  id: string;
  prices: Price[];
  status: CatalogStatus;
  translations: Translation[];
  version: number;
}

interface PointsPackage {
  bonusPoints: number;
  code: string;
  id: string;
  pointsAmount: number;
  prices: Price[];
  status: CatalogStatus;
  translations: Translation[];
  version: number;
}

interface ContentPrice extends Price {
  targetTitle?: string;
  id: string;
  targetId: string;
  targetType: 'drama' | 'episode';
  version: number;
}

interface ContentPointPrice {
  targetTitle?: string;
  id: string;
  pointsAmount: number;
  status: CatalogStatus;
  targetId: string;
  targetType: 'drama' | 'episode';
  version: number;
}

interface CatalogResponse {
  contentPointPrices: ContentPointPrice[];
  contentPrices: ContentPrice[];
  membershipPlans: MembershipPlan[];
  pointsTopupPackages: PointsPackage[];
}

interface CatalogCreateForm {
  code: string;
  bonusPoints?: number;
  durationDays?: number;
  pointsAmount?: number;
  status: CatalogStatus;
  translations: Translation[];
}

interface PriceForm {
  amountMajor: string;
  currency: Currency;
  status: CatalogStatus;
}

interface ContentPriceForm extends PriceForm {
  targetId: string;
  targetType: 'drama' | 'episode';
}

interface ContentPointPriceForm {
  pointsAmount: number;
  status: CatalogStatus;
  targetId: string;
  targetType: 'drama' | 'episode';
}

interface TranslationForm {
  translations: Translation[];
}

type PriceTarget =
  | { id: string; kind: 'membership'; label: string }
  | { id: string; kind: 'points'; label: string };

type TranslationTarget = {
  id: string;
  kind: 'membership' | 'points';
  label: string;
  version: number;
};

const API_BASE = '/api/v1/tenant/commerce/catalog';
const currencyOptions = ['CNY', 'USD', 'EUR', 'JPY', 'KRW'].map((value) => ({
  label: value,
  value,
}));
const localeOptions = APP_LOCALE_OPTIONS;
const statusOptions = [
  { label: '启用', value: 'active' },
  { label: '停用', value: 'disabled' },
];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const emptyCatalog: CatalogResponse = {
  contentPointPrices: [],
  contentPrices: [],
  membershipPlans: [],
  pointsTopupPackages: [],
};

export function CommerceCatalogPage() {
  const { principal, request } = useAuth();
  const [messageApi, messageContext] = message.useMessage();
  const [planForm] = Form.useForm<CatalogCreateForm>();
  const [pointsForm] = Form.useForm<CatalogCreateForm>();
  const [priceForm] = Form.useForm<PriceForm>();
  const [contentPriceForm] = Form.useForm<ContentPriceForm>();
  const [contentPointPriceForm] = Form.useForm<ContentPointPriceForm>();
  const [translationForm] = Form.useForm<TranslationForm>();
  const moneyTargetType = Form.useWatch('targetType', contentPriceForm);
  const pointsTargetType = Form.useWatch('targetType', contentPointPriceForm);
  const [catalog, setCatalog] = useState(emptyCatalog);
  const [activeTab, setActiveTab] = useState('membership');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState<'plan' | 'points' | 'content-price' | 'content-point-price'>();
  const [contentPointTarget, setContentPointTarget] = useState<ContentPointPrice>();
  const [priceTarget, setPriceTarget] = useState<PriceTarget>();
  const [translationTarget, setTranslationTarget] = useState<TranslationTarget>();
  const [submitting, setSubmitting] = useState<string>();
  const canManage = principal?.permissions.includes('commerce.catalog.manage') ?? false;

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      setCatalog(await request<CatalogResponse>(API_BASE));
    } catch (reason) {
      setError(errorMessage(reason, '商品目录加载失败'));
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate(kind: 'plan' | 'points' | 'content-price' | 'content-point-price'): void {
    setDialog(kind);
    if (kind === 'plan') {
      planForm.resetFields();
      planForm.setFieldsValue({
        status: 'active',
        translations: [{ locale: 'zh-CN', name: '' }],
      });
    } else if (kind === 'points') {
      pointsForm.resetFields();
      pointsForm.setFieldsValue({
        bonusPoints: 0,
        status: 'active',
        translations: [{ locale: 'zh-CN', name: '' }],
      });
    } else if (kind === 'content-price') {
      contentPriceForm.resetFields();
      contentPriceForm.setFieldsValue({ currency: 'USD', status: 'active', targetType: 'drama' });
    } else {
      setContentPointTarget(undefined);
      contentPointPriceForm.resetFields();
      contentPointPriceForm.setFieldsValue({ status: 'active', targetType: 'drama' });
    }
  }

  function editContentPrice(price: ContentPrice): void {
    contentPriceForm.resetFields();
    contentPriceForm.setFieldsValue({
      amountMajor: (price.amountMinor / 10 ** fractionDigits(price.currency)).toFixed(fractionDigits(price.currency)),
      currency: price.currency,
      status: price.status,
      targetId: price.targetId,
      targetType: price.targetType,
    });
    setDialog('content-price');
  }

  function editContentPointPrice(price: ContentPointPrice): void {
    setContentPointTarget(price);
    contentPointPriceForm.resetFields();
    contentPointPriceForm.setFieldsValue({
      pointsAmount: price.pointsAmount,
      status: price.status,
      targetId: price.targetId,
      targetType: price.targetType,
    });
    setDialog('content-point-price');
  }

  async function createPlan(values: CatalogCreateForm): Promise<void> {
    setSubmitting('plan');
    try {
      await request(`${API_BASE}/membership-plans`, {
        body: JSON.stringify(normalizeCreate(values)),
        method: 'POST',
      });
      messageApi.success('会员套餐已创建');
      setDialog(undefined);
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '会员套餐创建失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function createPoints(values: CatalogCreateForm): Promise<void> {
    setSubmitting('points');
    try {
      await request(`${API_BASE}/points-topup-packages`, {
        body: JSON.stringify(normalizeCreate(values)),
        method: 'POST',
      });
      messageApi.success('金币充值包已创建');
      setDialog(undefined);
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '金币充值包创建失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function savePrice(values: PriceForm): Promise<void> {
    if (!priceTarget) return;
    setSubmitting(`price:${priceTarget.id}`);
    const segment = priceTarget.kind === 'membership'
      ? 'membership-plans'
      : 'points-topup-packages';
    try {
      await request(
        `${API_BASE}/${segment}/${encodeURIComponent(priceTarget.id)}/prices/${values.currency}`,
        {
          body: JSON.stringify({ amountMinor: parseMajorAmount(values.amountMajor, values.currency), status: values.status }),
          method: 'PUT',
        },
      );
      messageApi.success('价格已保存');
      setPriceTarget(undefined);
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '价格保存失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function saveContentPrice(values: ContentPriceForm): Promise<void> {
    setSubmitting('content-price');
    try {
      await request(
        `${API_BASE}/content-prices/${values.targetType}/${encodeURIComponent(values.targetId.trim())}/${values.currency}`,
        {
          body: JSON.stringify({ amountMinor: parseMajorAmount(values.amountMajor, values.currency), status: values.status }),
          method: 'PUT',
        },
      );
      messageApi.success('内容价格已保存');
      setDialog(undefined);
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '内容价格保存失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function saveContentPointPrice(values: ContentPointPriceForm): Promise<void> {
    const targetType = contentPointTarget?.targetType ?? values.targetType;
    const targetId = contentPointTarget?.targetId ?? values.targetId.trim();
    setSubmitting('content-point-price');
    try {
      await request(
        `${API_BASE}/content-point-prices/${targetType}/${encodeURIComponent(targetId)}`,
        {
          body: JSON.stringify({
            pointsAmount: values.pointsAmount,
            status: values.status,
            version: contentPointTarget?.version ?? 0,
          }),
          method: 'PUT',
        },
      );
      messageApi.success(contentPointTarget ? '金币价格已更新' : '金币价格已创建');
      setDialog(undefined);
      setContentPointTarget(undefined);
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '金币价格保存失败'));
      if (reason instanceof ApiError && reason.status === 409) {
        setDialog(undefined);
        setContentPointTarget(undefined);
        await load();
      }
    } finally {
      setSubmitting(undefined);
    }
  }

  async function saveTranslations(values: TranslationForm): Promise<void> {
    if (!translationTarget) return;
    setSubmitting(`translations:${translationTarget.id}`);
    const segment = translationTarget.kind === 'membership'
      ? 'membership-plans'
      : 'points-topup-packages';
    try {
      await request(
        `${API_BASE}/${segment}/${encodeURIComponent(translationTarget.id)}/translations`,
        {
          body: JSON.stringify({
            translations: normalizeTranslations(values.translations),
            version: translationTarget.version,
          }),
          method: 'PUT',
        },
      );
      messageApi.success('多语言文案已更新');
      setTranslationTarget(undefined);
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '多语言文案更新失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  async function toggleStatus(
    kind: 'membership' | 'points',
    record: MembershipPlan | PointsPackage,
  ): Promise<void> {
    setSubmitting(`status:${record.id}`);
    const segment = kind === 'membership' ? 'membership-plans' : 'points-topup-packages';
    try {
      await request(`${API_BASE}/${segment}/${encodeURIComponent(record.id)}/status`, {
        body: JSON.stringify({
          status: record.status === 'active' ? 'disabled' : 'active',
          version: record.version,
        }),
        method: 'PATCH',
      });
      messageApi.success(record.status === 'active' ? '已停用' : '已启用');
      await load();
    } catch (reason) {
      messageApi.error(errorMessage(reason, '状态修改失败'));
    } finally {
      setSubmitting(undefined);
    }
  }

  function openPrice(target: PriceTarget, prices: Price[]): void {
    priceForm.resetFields();
    const current = prices[0];
    priceForm.setFieldsValue(current ? { ...current, amountMajor: (current.amountMinor / 10 ** fractionDigits(current.currency)).toFixed(fractionDigits(current.currency)) } : { currency: 'USD', status: 'active' });
    setPriceTarget(target);
  }

  function openTranslations(
    kind: TranslationTarget['kind'],
    record: MembershipPlan | PointsPackage,
  ): void {
    translationForm.resetFields();
    translationForm.setFieldsValue({
      translations: record.translations.map((translation) => ({ ...translation })),
    });
    setTranslationTarget({
      id: record.id,
      kind,
      label: displayName(record),
      version: record.version,
    });
  }

  const createButton = canManage ? (
    <Button type="primary" onClick={() => openCreate(
      activeTab === 'membership'
        ? 'plan'
        : activeTab === 'points'
          ? 'points'
          : activeTab === 'content'
            ? 'content-price'
            : 'content-point-price'
    )}>
      {activeTab === 'membership'
        ? '创建会员套餐'
        : activeTab === 'points'
          ? '创建金币包'
          : activeTab === 'content'
            ? '设置内容价格'
            : '设置金币价格'}
    </Button>
  ) : null;

  return (
    <>
      {messageContext}
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>商品与定价</Typography.Title>
          <Typography.Text type="secondary">
            管理会员、金币充值包与剧目价格。
          </Typography.Text>
        </div>
        {createButton}
      </div>

      <Alert
        className="page-alert"
        message="按实际售价填写金额，例如美元 9.99。日元和韩元仅支持整数。"
        showIcon
        type="info"
      />
      {error ? (
        <Alert
          action={<Button size="small" onClick={() => void load()}>重试</Button>}
          className="page-alert"
          message={error}
          showIcon
          type="error"
        />
      ) : null}

      <Tabs
        activeKey={activeTab}
        items={[
          {
            key: 'membership',
            label: '会员套餐',
            children: (
              <CatalogTable<MembershipPlan>
                canManage={canManage}
                data={catalog.membershipPlans}
                kind="membership"
                loading={loading}
                onPrice={(record) => openPrice({
                  id: record.id,
                  kind: 'membership',
                  label: displayName(record),
                }, record.prices)}
                onStatus={(record) => void toggleStatus('membership', record)}
                onTranslations={(record) => openTranslations('membership', record)}
                submitting={submitting}
              />
            ),
          },
          {
            key: 'points',
            label: '金币充值包',
            children: (
              <CatalogTable<PointsPackage>
                canManage={canManage}
                data={catalog.pointsTopupPackages}
                kind="points"
                loading={loading}
                onPrice={(record) => openPrice({
                  id: record.id,
                  kind: 'points',
                  label: displayName(record),
                }, record.prices)}
                onStatus={(record) => void toggleStatus('points', record)}
                onTranslations={(record) => openTranslations('points', record)}
                submitting={submitting}
              />
            ),
          },
          {
            key: 'content',
            label: '内容价格',
            children: (
              <ContentPriceTable
                canManage={canManage}
                data={catalog.contentPrices}
                loading={loading}
                onEdit={editContentPrice}
              />
            ),
          },
          {
            key: 'content-points',
            label: '内容金币价格',
            children: (
              <ContentPointPriceTable
                canManage={canManage}
                data={catalog.contentPointPrices}
                loading={loading}
                onEdit={editContentPointPrice}
              />
            ),
          },
        ]}
        onChange={setActiveTab}
      />

      <CreateCatalogModal
        form={planForm}
        kind="membership"
        loading={submitting === 'plan'}
        onCancel={() => setDialog(undefined)}
        onFinish={(values) => void createPlan(values)}
        open={dialog === 'plan'}
      />
      <CreateCatalogModal
        form={pointsForm}
        kind="points"
        loading={submitting === 'points'}
        onCancel={() => setDialog(undefined)}
        onFinish={(values) => void createPoints(values)}
        open={dialog === 'points'}
      />
      <PriceModal
        form={priceForm}
        loading={Boolean(priceTarget && submitting === `price:${priceTarget.id}`)}
        onCancel={() => setPriceTarget(undefined)}
        onFinish={(values) => void savePrice(values)}
        onCurrencyChange={currency => {
          const products = priceTarget?.kind === 'membership' ? catalog.membershipPlans : catalog.pointsTopupPackages;
          const price = products.find(product => product.id === priceTarget?.id)?.prices.find(item => item.currency === currency);
          priceForm.setFieldsValue({ amountMajor: price ? (price.amountMinor / 10 ** fractionDigits(currency)).toFixed(fractionDigits(currency)) : '', status: price?.status ?? 'active' });
        }}
        open={Boolean(priceTarget)}
        title={`设置价格·${priceTarget?.label ?? ''}`}
      />
      <Modal
        confirmLoading={Boolean(
          translationTarget && submitting === `translations:${translationTarget.id}`,
        )}
        onCancel={() => setTranslationTarget(undefined)}
        onOk={() => translationForm.submit()}
        open={Boolean(translationTarget)}
        title={`编辑多语言文案·${translationTarget?.label ?? ''}`}
        width={820}
      >
        <Form name="commercecatalogpage-1" form={translationForm} layout="vertical" onFinish={(values) => void saveTranslations(values)}>
          <TranslationFields />
        </Form>
      </Modal>
      <Modal
        confirmLoading={submitting === 'content-price'}
        onCancel={() => setDialog(undefined)}
        onOk={() => contentPriceForm.submit()}
        open={dialog === 'content-price'}
        title="设置内容价格"
      >
        <Form name="commercecatalogpage-2" form={contentPriceForm} layout="vertical" onFinish={(values) => void saveContentPrice(values)}>
          <div className="two-column-form">
            <Form.Item label="内容类型" name="targetType" rules={[{ required: true }]}>
              <Select onChange={() => contentPriceForm.setFieldValue('targetId', undefined)} options={[{ label: '整部短剧', value: 'drama' }, { label: '单集', value: 'episode' }]} />
            </Form.Item>
            <Form.Item label="选择内容" name="targetId" rules={[{ required: true, message: '请选择需要定价的内容' }]}>
              <ContentTargetSelect type={moneyTargetType} />
            </Form.Item>
          </div>
          <PriceFields />
        </Form>
      </Modal>
      <Modal
        confirmLoading={submitting === 'content-point-price'}
        onCancel={() => {
          setDialog(undefined);
          setContentPointTarget(undefined);
        }}
        onOk={() => contentPointPriceForm.submit()}
        open={dialog === 'content-point-price'}
        title={contentPointTarget ? '更新内容金币价格' : '创建内容金币价格'}
      >
        <Alert
          className="page-alert"
          message="选择已上架的短剧或单集，设置解锁所需金币。"
          showIcon
          type="info"
        />
        <Form
          name="commercecatalogpage-3" form={contentPointPriceForm}
          layout="vertical"
          onFinish={(values) => void saveContentPointPrice(values)}
        >
          <div className="two-column-form">
            <Form.Item label="内容类型" name="targetType" rules={[{ required: true }]}>
              <Select
                disabled={Boolean(contentPointTarget)}
                onChange={() => contentPointPriceForm.setFieldValue('targetId', undefined)}
                options={[{ label: '整部短剧', value: 'drama' }, { label: '单集', value: 'episode' }]}
              />
            </Form.Item>
            <Form.Item
              label="选择内容"
              name="targetId"
              rules={[
                { required: true, whitespace: true },
                { message: '请输入有效 UUID', pattern: UUID_PATTERN },
              ]}
            >
              <ContentTargetSelect disabled={Boolean(contentPointTarget)} type={pointsTargetType} />
            </Form.Item>
            <Form.Item label="所需金币" name="pointsAmount" rules={[{ required: true }]}>
              <InputNumber min={1} max={9_000_000_000_000_000} precision={0} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item label="状态" name="status" rules={[{ required: true }]}>
              <Select options={statusOptions} />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </>
  );
}

function CatalogTable<T extends MembershipPlan | PointsPackage>({
  canManage,
  data,
  kind,
  loading,
  onPrice,
  onStatus,
  onTranslations,
  submitting,
}: {
  canManage: boolean;
  data: T[];
  kind: 'membership' | 'points';
  loading: boolean;
  onPrice(record: T): void;
  onStatus(record: T): void;
  onTranslations(record: T): void;
  submitting?: string;
}) {
  return (
    <Table<T>
      columns={[
        {
          key: 'name',
          title: '商品',
          render: (_, record) => (
            <Space direction="vertical" size={0}>
              <Typography.Text strong>{displayName(record)}</Typography.Text>
              <Typography.Text type="secondary">{record.code}</Typography.Text>
            </Space>
          ),
        },
        {
          key: 'spec',
          title: '规格',
          width: 150,
          render: (_, record) => kind === 'membership'
            ? `${(record as MembershipPlan).durationDays} 天`
            : `${(record as PointsPackage).pointsAmount} + ${(record as PointsPackage).bonusPoints} 金币`,
        },
        {
          dataIndex: 'translations',
          title: '语言',
          width: 260,
          render: (translations: Translation[]) => (
            <Space size={[4, 4]} wrap>
              {translations.map((translation) => <Tag key={translation.locale}>{translation.locale}</Tag>)}
            </Space>
          ),
        },
        {
          dataIndex: 'prices',
          title: '多币种价格',
          render: (prices: Price[]) => prices.length ? (
            <Space size={[4, 4]} wrap>
              {prices.map((price) => (
                <Tag color={price.status === 'active' ? 'green' : undefined} key={price.currency}>
                  {formatMoney(price.amountMinor, price.currency)}{price.status === 'disabled' ? '·停用' : ''}
                </Tag>
              ))}
            </Space>
          ) : <Typography.Text type="secondary">未设置</Typography.Text>,
        },
        {
          dataIndex: 'status',
          title: '状态',
          width: 90,
          render: (status: CatalogStatus) => status === 'active'
            ? <Tag color="green">启用</Tag>
            : <Tag>停用</Tag>,
        },
        {
          key: 'actions',
          title: '操作',
          width: 290,
          render: (_, record) => canManage ? (
            <Space>
              <Button size="small" onClick={() => onTranslations(record)}>编辑文案</Button>
              <Button size="small" onClick={() => onPrice(record)}>设置价格</Button>
              <Popconfirm
                onConfirm={() => onStatus(record)}
                title={record.status === 'active' ? '停用该商品？' : '启用该商品？'}
              >
                <Button loading={submitting === `status:${record.id}`} size="small">
                  {record.status === 'active' ? '停用' : '启用'}
                </Button>
              </Popconfirm>
            </Space>
          ) : <Typography.Text type="secondary">只读</Typography.Text>,
        },
      ]}
      dataSource={data}
      loading={loading}
      locale={{ emptyText: <Empty description="暂无商品" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
      pagination={false}
      rowKey="id"
      scroll={{ x: 1000 }}
    />
  );
}

function ContentPriceTable({
  canManage,
  data,
  loading,
  onEdit,
}: {
  canManage: boolean;
  data: ContentPrice[];
  loading: boolean;
  onEdit(price: ContentPrice): void;
}) {
  return (
    <Table<ContentPrice>
      columns={[
        { dataIndex: 'targetType', title: '类型', render: (value) => value === 'drama' ? '短剧' : '单集' },
        {
          dataIndex: 'targetTitle',
          title: '内容',
          render: (value?: string) => value ?? '内容名称暂不可用',
        },
        { dataIndex: 'currency', title: '币种', width: 90 },
        { dataIndex: 'amountMinor', title: '售价', width: 150, render: (amount: number, row) => formatMoney(amount, row.currency) },
        { dataIndex: 'status', title: '状态', width: 90, render: (value) => value === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag> },
        {
          key: 'action',
          title: '操作',
          width: 90,
          render: (_, price) => canManage
            ? <Button size="small" onClick={() => onEdit(price)}>编辑</Button>
            : <Typography.Text type="secondary">只读</Typography.Text>,
        },
      ]}
      dataSource={data}
      loading={loading}
      locale={{ emptyText: <Empty description="暂无内容价格" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
      pagination={false}
      rowKey="id"
    />
  );
}

function ContentPointPriceTable({
  canManage,
  data,
  loading,
  onEdit,
}: {
  canManage: boolean;
  data: ContentPointPrice[];
  loading: boolean;
  onEdit(price: ContentPointPrice): void;
}) {
  return (
    <Table<ContentPointPrice>
      columns={[
        {
          dataIndex: 'targetType',
          title: '类型',
          width: 90,
          render: (value) => value === 'drama' ? '短剧' : '单集',
        },
        {
          dataIndex: 'targetTitle',
          title: '内容',
          render: (value?: string) => value ?? '内容名称暂不可用',
        },
        { dataIndex: 'pointsAmount', title: '所需金币', width: 120 },
        {
          dataIndex: 'status',
          title: '状态',
          width: 90,
          render: (value) => value === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>,
        },
        { dataIndex: 'version', title: '版本', width: 80 },
        {
          key: 'action',
          title: '操作',
          width: 90,
          render: (_, price) => canManage
            ? <Button size="small" onClick={() => onEdit(price)}>编辑</Button>
            : <Typography.Text type="secondary">只读</Typography.Text>,
        },
      ]}
      dataSource={data}
      loading={loading}
      locale={{ emptyText: <Empty description="暂无内容金币价格" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
      pagination={false}
      rowKey="id"
    />
  );
}

function CreateCatalogModal({
  form,
  kind,
  loading,
  onCancel,
  onFinish,
  open,
}: {
  form: ReturnType<typeof Form.useForm<CatalogCreateForm>>[0];
  kind: 'membership' | 'points';
  loading: boolean;
  onCancel(): void;
  onFinish(values: CatalogCreateForm): void;
  open: boolean;
}) {
  return (
    <Modal
      confirmLoading={loading}
      onCancel={onCancel}
      onOk={() => form.submit()}
      open={open}
      title={kind === 'membership' ? '创建会员套餐' : '创建金币充值包'}
      width={820}
    >
      <Form<CatalogCreateForm> name="commercecatalogpage-4" form={form} layout="vertical" onFinish={onFinish}>
        <div className="two-column-form">
          <Form.Item label="商品代码" name="code" rules={[{ required: true, whitespace: true }]}>
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item label="状态" name="status" rules={[{ required: true }]}>
            <Select options={statusOptions} />
          </Form.Item>
          {kind === 'membership' ? (
            <Form.Item label="有效天数" name="durationDays" rules={[{ required: true }]}>
              <InputNumber min={1} max={3650} precision={0} style={{ width: '100%' }} />
            </Form.Item>
          ) : (
            <>
              <Form.Item label="金币数量" name="pointsAmount" rules={[{ required: true }]}>
                <InputNumber min={1} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item label="赠送金币" name="bonusPoints">
                <InputNumber min={0} precision={0} style={{ width: '100%' }} />
              </Form.Item>
            </>
          )}
        </div>
        <TranslationFields />
      </Form>
    </Modal>
  );
}

function TranslationFields() {
  return (
    <>
      <Typography.Title className="form-section-title" level={5}>多语言名称</Typography.Title>
      <Form.List
        name="translations"
        rules={[{
          validator: async (_, translations?: Translation[]) => {
            if (!translations?.length) throw new Error('至少填写一种语言');
            const locales = translations.map((translation) => translation?.locale).filter(Boolean);
            if (new Set(locales).size !== locales.length) throw new Error('语言不能重复');
          },
        }]}
      >
        {(fields, { add, remove }, { errors }) => (
          <>
            {fields.map((field) => (
              <div className="translation-form-row" key={field.key}>
                <Form.Item name={[field.name, 'locale']} rules={[{ required: true, message: '请选择语言' }]}>
                  <Select options={localeOptions} placeholder="语言" />
                </Form.Item>
                <Form.Item name={[field.name, 'name']} rules={[{ required: true, whitespace: true, message: '请填写商品名称' }]}>
                  <Input maxLength={120} placeholder="商品名称" />
                </Form.Item>
                <Form.Item name={[field.name, 'description']}>
                  <Input maxLength={1000} placeholder="简介（可选）" />
                </Form.Item>
                <Button danger disabled={fields.length === 1} onClick={() => remove(field.name)}>删除</Button>
              </div>
            ))}
            <Button
              disabled={fields.length >= localeOptions.length}
              onClick={() => add({ locale: 'en-US', name: '' })}
            >
              添加语言
            </Button>
            <Form.ErrorList errors={errors} />
          </>
        )}
      </Form.List>
    </>
  );
}

function PriceModal({ form, loading, onCancel, onFinish, onCurrencyChange, open, title }: {
  form: ReturnType<typeof Form.useForm<PriceForm>>[0];
  loading: boolean;
  onCancel(): void;
  onFinish(values: PriceForm): void;
  onCurrencyChange(currency: Currency): void;
  open: boolean;
  title: string;
}) {
  return (
    <Modal confirmLoading={loading} onCancel={onCancel} onOk={() => form.submit()} open={open} title={title}>
      <Form name="commercecatalogpage-5" form={form} layout="vertical" onFinish={onFinish} onValuesChange={changed => { if (changed.currency) onCurrencyChange(changed.currency); }}>
        <PriceFields />
      </Form>
    </Modal>
  );
}

function PriceFields() {
  return (
    <div className="two-column-form">
      <Form.Item label="币种" name="currency" rules={[{ required: true }]}>
        <Select options={currencyOptions} />
      </Form.Item>
      <Form.Item label="售价" name="amountMajor" dependencies={['currency']} rules={[
        { required: true, message: '请输入售价' },
        ({ getFieldValue }) => ({ validator: async (_, value) => { if (value) parseMajorAmount(value, getFieldValue('currency') ?? 'USD'); } }),
      ]}>
        <Input inputMode="decimal" placeholder="例如 9.99" />
      </Form.Item>
      <Form.Item label="状态" name="status" rules={[{ required: true }]}>
        <Select options={statusOptions} />
      </Form.Item>
    </div>
  );
}

function normalizeCreate(values: CatalogCreateForm): CatalogCreateForm {
  return {
    ...values,
    code: values.code.trim(),
    translations: normalizeTranslations(values.translations),
  };
}

function normalizeTranslations(translations: Translation[]): Translation[] {
  return translations.map((translation) => ({
    description: translation.description?.trim() ?? '',
    locale: translation.locale,
    name: translation.name.trim(),
  }));
}

function displayName(record: MembershipPlan | PointsPackage): string {
  return record.translations.find((translation) => translation.locale === 'zh-CN')?.name
    ?? record.translations[0]?.name
    ?? record.code;
}

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof ApiError && reason.status === 409) {
    return '数据版本已变化，已刷新最新数据，请重新操作';
  }
  return reason instanceof ApiError ? reason.message : fallback;
}
