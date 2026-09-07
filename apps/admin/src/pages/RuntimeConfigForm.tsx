import { APP_LOCALE_OPTIONS } from '@drama/contracts';
import { Button, Col, Divider, Form, Input, Row, Select, Space, Switch, type FormInstance } from 'antd';
import { adFormats, type RuntimeValues } from './runtime-config-ui';

export function RuntimeConfigForm({ form, disabled, loading, onSave }: {
  form: FormInstance<RuntimeValues>; disabled: boolean; loading: boolean;
  onSave(values: RuntimeValues): void;
}) {
  return <Form name="runtimeconfigform-1" form={form} disabled={disabled} layout="vertical" onFinish={onSave}>
    <Form.Item name="supportedLocales" label="支持语言" rules={[{ required: true, message: '请至少选择一种语言' }]}>
      <Select mode="multiple" options={APP_LOCALE_OPTIONS} optionFilterProp="label" placeholder="选择 App 支持的语言" />
    </Form.Item>
    <Form.Item name="allowedCountries" label="发行国家或地区" extra="留空表示不限制；输入两位国家代码后按回车，例如 US、SG。"
      rules={[{ validator: async (_, codes?: string[]) => { if (codes?.some(code => !/^[a-z]{2}$/i.test(code))) throw new Error('请输入两位国家代码'); } }]}>
      <Select mode="tags" tokenSeparators={[',', '，', ' ']} placeholder="不限制" />
    </Form.Item>
    <Form.Item name="deepLinkHost" label="App 分享域名" extra="仅填写域名，不含 https:// 或路径。"
      rules={[{ pattern: /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, message: '请输入有效域名' }]}>
      <Input placeholder="例如 drama.example.com" />
    </Form.Item>
    <Divider titlePlacement="left">广告设置</Divider>
    <Form.Item name="adsEnabled" label="启用广告" valuePropName="checked"><Switch /></Form.Item>
    <Row gutter={24}>
      {(['android', 'ios'] as const).map(platform => <Col xs={24} lg={12} key={platform}>
        <h3>{platform === 'android' ? 'Android' : 'iOS'}</h3>
        {adFormats.map(format => <Form.Item key={format.value} name={['ads', platform, format.value]} label={format.label}
          rules={[{ pattern: /^ca-app-pub-\d{16}\/\d{10}$/, message: '请输入有效的 AdMob 广告位 ID' }]}>
          <Input aria-label={`${platform} ${format.label}`} placeholder="未配置则不展示此类广告" allowClear />
        </Form.Item>)}
      </Col>)}
    </Row>
    <Divider titlePlacement="left">商店商品</Divider>
    <Form.List name="products">{(fields, { add, remove }) => <>
      {fields.map(field => <Row key={field.key} gutter={12}>
        <Col xs={24} md={6}><Form.Item name={[field.name, 'platform']} label="商店" rules={[{ required: true }]}><Select options={[{ value: 'apple', label: 'Apple App Store' }, { value: 'google', label: 'Google Play' }]} /></Form.Item></Col>
        <Col xs={24} md={6}><Form.Item name={[field.name, 'kind']} label="商品类型" rules={[{ required: true }]}><Select options={[{ value: 'membership', label: '会员订阅' }, { value: 'points_topup', label: '金币充值' }]} /></Form.Item></Col>
        <Col xs={20} md={10}><Form.Item name={[field.name, 'id']} label="商店商品 ID" rules={[{ required: true, whitespace: true, message: '填写商店中已创建的商品 ID' }]}><Input maxLength={200} /></Form.Item></Col>
        <Col xs={4} md={2}><Button danger style={{ marginTop: 30 }} aria-label={`删除商品 ${field.name + 1}`} onClick={() => remove(field.name)}>删除</Button></Col>
      </Row>)}
      <Button onClick={() => add({ platform: 'google', kind: 'points_topup' })}>添加商店商品</Button>
    </>}</Form.List>
    <Space style={{ marginTop: 24, display: 'flex' }}><Button htmlType="submit" type="primary" loading={loading}>保存运行配置</Button></Space>
  </Form>;
}
