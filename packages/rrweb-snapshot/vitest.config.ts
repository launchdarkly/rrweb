/// <reference types="vitest" />
import { configDefaults, defineProject, mergeConfig } from 'vitest/config';
import configShared from '../../vitest.config.ts';

export default mergeConfig(
  configShared,
  defineProject({
    test: {
      globals: true,
      exclude: [...configDefaults.exclude, 'test/monkey-patched.test.ts'],
    },
  }),
);
