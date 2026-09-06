import { APP_LOCALE_OPTIONS } from '@drama/contracts';
import {
  Alert,
  Button,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';
import { PlatformAppBuildDrawer } from './PlatformAppBuildDrawer';
import { PlatformMerchantSettingsDrawer } from './PlatformMerchantSettingsDrawer';

interface MerchantRecord {
  code: string;
  createdAt: string;
  defaultCurrency: string;
  defaultLocale: string;
  expiresAt: string;
  id: string;
  name: string;
  primaryDomain: string;
  status: 'active' | 'expired' | 'suspended';
  timezone: string;
  version: number;
}

interface MerchantListResponse {
  items: MerchantRecord[];
  page: number;
  pageSize: number;
  total: number;
}

interface CreateMerchantForm {
  code: string;
  defaultCurrency: string;
  defaultLocale: string;
  expiresAt: { toISOString(): string };
  name: string;
  owner: {
    email?: string;
    password: string;
    phone?: string;
    username: string;
  };
  timezone: string;
}

const statusLabels = {
  active: { color: 'green', text: '正常' },
  expired: { color: 'orange', text: '已到期' },
  suspended: { color: 'red', text: '已暂停' },
} as const;

export function MerchantListPage() {
  const { principal, request } = useAuth();
  const [form] = Form.useForm<CreateMerchantForm>();
  const [data, setData] = useState<MerchantListResponse>({
    items: [],
    page: 1,
    pageSize: 20,
    total: 0,
  });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [settingsMerchant, setSettingsMerchant] = useState<MerchantRecord>();
  const [buildMerchant, setBuildMerchant] = useState<MerchantRecord>();

  const canCreate = principal?.permissions.includes('platform.merchant.create');
  const canReadAppBuild = principal?.permissions.includes('platform.app_build.read');

  const load = useCallback(
    async (page = 1, pageSize = 20) => {
      setLoading(true);
      setError(undefined);
      try {
        const result = await request<MerchantListResponse>(
          `/api/v1/platform/merchants?page=${page}&pageSize=${pageSize}`,
        );
        setData(result);
      } catch (reason) {
        setError(reason instanceof ApiError ? reason.message : '代理商数据加载失败');
      } finally {
        setLoading(false);
      }
    },
    [request],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function createMerchant(values: CreateMerchantForm): Promise<void> {
    setSubmitting(true);
    setError(undefined);
    try {
      await request<MerchantRecord>('/api/v1/platform/merchants', {
        body: JSON.stringify({
          ...values,
          expiresAt: values.expiresAt.toISOString(),
        }),
        method: 'POST',
      });
      setModalOpen(false);
      form.resetFields();
      await load(1);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '代理商创建失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="page-heading">
        <div>
          <Typography.Title level={2}>代理商管理</Typography.Title>
          <Typography.Text type="secondary">
            代理商仅由总后台创建，账号、域名、数据和权限相互隔离。
          </Typography.Text>
        </div>
        {canCreate ? (
          <Button type="primary" onClick={() => setModalOpen(true)}>
            创建代理商
          </Button>
        ) : null}
      </div>

      {error ? <Alert closable message={error} type="error" showIcon /> : null}

      <Table<MerchantRecord>
        dataSource={data.items}
        loading={loading}
        rowKey="id"
        pagination={{
          current: data.page,
          onChange: (page, pageSize) => void load(page, pageSize),
          pageSize: data.pageSize,
          showSizeChanger: true,
          total: data.total,
        }}
        columns={[
          {
            dataIndex: 'name',
            title: '代理商',
            render: (name: string, row) => (
              <Space direction="vertical" size={0}>
                <Typography.Text strong>{name}</Typography.Text>
                <Typography.Text type="secondary">{row.code}</Typography.Text>
              </Space>
            ),
          },
          { dataIndex: 'primaryDomain', title: '主域名' },
          {
            dataIndex: 'status',
            title: '状态',
            render: (status: MerchantRecord['status']) => {
              const option = statusLabels[status];
              return <Tag color={option.color}>{option.text}</Tag>;
            },
          },
          {
            dataIndex: 'expiresAt',
            title: '到期时间',
            render: (value: string) => new Date(value).toLocaleString(),
          },
          {
            key: 'locale',
            title: '语言/币种',
            render: (_, row) => `${row.defaultLocale} / ${row.defaultCurrency}`,
          },
          {
            key: 'actions',
            title: '操作',
            width: 220,
            render: (_, row) => (
              <Space wrap>
                <Button size="small" onClick={() => setSettingsMerchant(row)}>
                  站点配置
                </Button>
                {canReadAppBuild ? (
                  <Button size="small" onClick={() => setBuildMerchant(row)}>
                    应用构建
                  </Button>
                ) : null}
              </Space>
            ),
          },
        ]}
      />

      <PlatformMerchantSettingsDrawer
        merchant={settingsMerchant}
        onClose={() => setSettingsMerchant(undefined)}
        principal={principal}
      />

      <PlatformAppBuildDrawer
        merchant={buildMerchant}
        onClose={() => setBuildMerchant(undefined)}
        principal={principal}
      />

      <Modal
        destroyOnHidden
        footer={null}
        onCancel={() => setModalOpen(false)}
        open={modalOpen}
        title="创建代理商"
        width={680}
      >
        <Form<CreateMerchantForm>
          form={form}
          initialValues={{
            defaultCurrency: 'USD',
            defaultLocale: 'en-US',
            timezone: 'Asia/Tokyo',
          }}
          layout="vertical"
          onFinish={(values) => void createMerchant(values)}
          requiredMark={false}
        >
          <div className="two-column-form">
            <Form.Item label="代理商名称" name="name" rules={[{ required: true }]}>
              <Input maxLength={200} />
            </Form.Item>
            <Form.Item
              label="代理商代码"
              name="code"
              extra="用于生成平台子域名，创建后不可随意修改"
              rules={[
                { required: true },
                { pattern: /^[a-z0-9][a-z0-9-]{1,62}$/, message: '仅限小写字母、数字和连字符' },
              ]}
            >
              <Input placeholder="merchant-a" />
            </Form.Item>
            <Form.Item label="默认语言" name="defaultLocale" rules={[{ required: true }]}>
              <Select options={APP_LOCALE_OPTIONS} />
            </Form.Item>
            <Form.Item label="默认币种" name="defaultCurrency" rules={[{ required: true }]}>
              <Select options={['USD', 'JPY', 'EUR', 'KRW', 'CNY'].map((value) => ({ label: value, value }))} />
            </Form.Item>
            <Form.Item label="时区" name="timezone" rules={[{ required: true }]}>
              <Select options={[
                { label: '东京', value: 'Asia/Tokyo' },
                { label: '洛杉矶', value: 'America/Los_Angeles' },
                { label: '纽约', value: 'America/New_York' },
                { label: '巴黎', value: 'Europe/Paris' },
                { label: '上海', value: 'Asia/Shanghai' },
              ]} />
            </Form.Item>
            <Form.Item label="到期时间" name="expiresAt" rules={[{ required: true }]}>
              <DatePicker showTime style={{ width: '100%' }} />
            </Form.Item>
          </div>

          <Typography.Title level={5}>代理商所有者账号</Typography.Title>
          <div className="two-column-form">
            <Form.Item
              label="登录账号"
              name={['owner', 'username']}
              rules={[{ required: true }, { min: 3 }]}
            >
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item
              label="初始密码"
              name={['owner', 'password']}
              rules={[{ required: true }, { min: 12, message: '至少12个字符' }]}
            >
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item label="邮箱" name={['owner', 'email']} rules={[{ type: 'email' }]}>
              <Input />
            </Form.Item>
            <Form.Item label="手机号" name={['owner', 'phone']} extra="国际格式，例如 +819012345678">
              <Input />
            </Form.Item>
          </div>

          <Button block htmlType="submit" loading={submitting} type="primary">
            确认创建
          </Button>
        </Form>
      </Modal>
    </>
  );
}
