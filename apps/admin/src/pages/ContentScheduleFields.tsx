import { DatePicker, Form } from 'antd';
import dayjs from 'dayjs';

export const dateTimeFormProps = {
    getValueProps: (value?: string) => ({ value: value ? dayjs(value) : null }),
    normalize: (value: dayjs.Dayjs | null) => value?.toISOString(),
};

export function ContentScheduleFields() {
  return <>
    <Form.Item label="发布时间" name="releaseAt" extra="可选，按当前电脑时区显示。" {...dateTimeFormProps}>
      <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
    </Form.Item>
    <Form.Item label="下架时间" name="unpublishAt" dependencies={['releaseAt']} {...dateTimeFormProps}
      rules={[({ getFieldValue }) => ({ validator: async (_, value?: string) => {
        if (!value) return;
        const releaseAt = getFieldValue('releaseAt');
        if (!releaseAt || Date.parse(value) <= Date.parse(releaseAt)) throw new Error('下架时间必须晚于发布时间');
      } })]}>
      <DatePicker showTime format="YYYY-MM-DD HH:mm" style={{ width: '100%' }} />
    </Form.Item>
  </>;
}
