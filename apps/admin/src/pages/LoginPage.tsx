import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
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
      <Card className="login-card" bordered={false}>
        <div className="login-brand">
          <div className="brand-mark">D</div>
          <div>
            <Typography.Title level={3}>Drama Cloud</Typography.Title>
            <Typography.Text type="secondary">
              {adminScope === 'platform' ? '平台总后台' : '商家管理后台'}
            </Typography.Text>
          </div>
        </div>

        {error ? <Alert message={error} type="error" showIcon /> : null}

        <Form<LoginForm>
          layout="vertical"
          onFinish={(values) => void submit(values)}
          requiredMark={false}
          size="large"
        >
          <Form.Item
            label="账号"
            name="username"
            rules={[{ required: true, message: '请输入账号' }]}
          >
            <Input autoComplete="username" prefix={<UserOutlined />} />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              autoComplete="current-password"
              prefix={<LockOutlined />}
            />
          </Form.Item>
          <Button block htmlType="submit" loading={submitting} type="primary">
            登录
          </Button>
        </Form>
      </Card>
    </main>
  );
}
