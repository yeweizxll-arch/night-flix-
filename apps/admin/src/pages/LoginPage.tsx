import { CheckCircleFilled, LockOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Tag, Typography } from 'antd';
import { useState } from 'react';

import { ApiError } from '../api/http';
import { useAuth } from '../auth/AuthProvider';

interface LoginForm {
  password: string;
  username: string;
}

export function LoginPage() {
  const { adminScope, login } = useAuth();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  async function submit(values: LoginForm): Promise<void> {
    setSubmitting(true);
    setError(undefined);
    try {
      await login(values.username.trim(), values.password);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '登录失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-shell">
        <div className="login-introduction">
          <div className="login-brand login-brand-inverse">
            <div className="brand-mark">NF</div>
            <div>
              <Typography.Title level={3}>Night Flix</Typography.Title>
              <Typography.Text>海外短剧 SaaS</Typography.Text>
            </div>
          </div>
          <div className="login-introduction-copy">
            <Typography.Title level={1}>
              {adminScope === 'platform' ? '管理公共内容与代理商网络' : '运营属于自己的短剧品牌'}
            </Typography.Title>
            <Typography.Paragraph>
              {adminScope === 'platform'
                ? '统一维护公共剧池、代理商权限、内容分成与平台安全。'
                : '独立审核上架、配置品牌与商品，并查看本代理商的用户和经营数据。'}
            </Typography.Paragraph>
          </div>
          <div className="login-capabilities">
            {(adminScope === 'platform'
              ? ['中央公共剧池统一管理', '代理商数据与权限严格隔离', '按币种结算与全链路审计']
              : ['自主选剧、审核与定价', '独立品牌、支付与广告配置', '本代理商数据专属可见']
            ).map((item) => (
              <div className="login-capability" key={item}>
                <CheckCircleFilled />
                <span>{item}</span>
              </div>
            ))}
          </div>
        </div>

        <Card className="login-card" bordered={false}>
          <Tag className="login-scope-tag" color={adminScope === 'platform' ? 'purple' : 'blue'}>
            {adminScope === 'platform' ? '总部管理中心' : '代理商工作台'}
          </Tag>
          <Typography.Title level={2}>欢迎回来</Typography.Title>
          <Typography.Paragraph className="login-card-description" type="secondary">
            使用管理员账号登录继续工作
          </Typography.Paragraph>

          {error ? <Alert message={error} type="error" showIcon /> : null}

          <Form<LoginForm>
            name="loginpage-1" layout="vertical"
            onFinish={(values) => void submit(values)}
            requiredMark={false}
            size="large"
          >
            <Form.Item
              label="账号"
              name="username"
              rules={[{ required: true, message: '请输入账号' }]}
            >
              <Input autoComplete="username" placeholder="用户名 / 邮箱 / 手机号" prefix={<UserOutlined />} />
            </Form.Item>
            <Form.Item
              label="密码"
              name="password"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                autoComplete="current-password"
                placeholder="请输入密码"
                prefix={<LockOutlined />}
              />
            </Form.Item>
            <Button block htmlType="submit" loading={submitting} type="primary">
              登录
            </Button>
          </Form>
          <div className="login-security-note">
            <SafetyCertificateOutlined />
            <span>登录行为与管理操作均会记录到安全审计</span>
          </div>
        </Card>
      </section>
    </main>
  );
}
