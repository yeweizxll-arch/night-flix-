export const H5_RELEASE_CHANNEL: 'production' | 'test' =
  import.meta.env.VITE_H5_RELEASE_CHANNEL === 'production' ? 'production' : 'test';

export const IS_TEST_RELEASE = H5_RELEASE_CHANNEL === 'test';
