/// <reference types="vitest" />
import { defineProject, mergeConfig } from 'vitest/config';
import configShared from '../../vitest.config';
import { resolve } from 'path';

export default mergeConfig(
  configShared,
  defineProject({
    resolve: {
      alias: [
        {
          find: '@rrweb/types',
          replacement: resolve(
            __dirname,
            '../../node_modules/@highlight-run/rrweb-types/dist/rrweb-types.js',
          ),
        },
        {
          find: '@rrweb/utils',
          replacement: resolve(
            __dirname,
            '../../node_modules/@highlight-run/rrweb-utils/dist/rrweb-utils.js',
          ),
        },
        {
          find: 'rrweb-snapshot',
          replacement: resolve(
            __dirname,
            '../../node_modules/@highlight-run/rrweb-snapshot/dist/rrweb-snapshot.js',
          ),
        },
        {
          find: '@rrweb/rrweb-plugin-sequential-id-record',
          replacement: resolve(
            __dirname,
            '../../node_modules/@highlight-run/rrweb-rrweb-plugin-sequential-id-record/dist/rrweb-rrweb-plugin-sequential-id-record.js',
          ),
        },
        {
          find: '@rrweb/rrweb-plugin-console-record',
          replacement: resolve(
            __dirname,
            '../../node_modules/@highlight-run/rrweb-rrweb-plugin-console-record/dist/rrweb-rrweb-plugin-console-record.js',
          ),
        },
        {
          find: /^rrweb$/,
          replacement: resolve(
            __dirname,
            '../../node_modules/@highlight-run/rrweb/dist/rrweb.js',
          ),
        },
        {
          find: /^rrweb\/(.*)$/,
          replacement: resolve(
            __dirname,
            '../../node_modules/@highlight-run/rrweb/$1',
          ),
        },
        {
          find: /^@rrweb\/replay$/,
          replacement: resolve(
            __dirname,
            '../../node_modules/@highlight-run/rrweb-replay/dist/rrweb-replay.js',
          ),
        },
        {
          find: /^@rrweb\/replay\/(.*)$/,
          replacement: resolve(
            __dirname,
            '../../node_modules/@highlight-run/rrweb-replay/$1',
          ),
        },
        {
          find: /^@rrweb\/packer$/,
          replacement: resolve(
            __dirname,
            '../../node_modules/@highlight-run/rrweb-packer/dist/packer.js',
          ),
        },
        {
          find: /^@rrweb\/packer\/unpack$/,
          replacement: resolve(
            __dirname,
            '../../node_modules/@highlight-run/rrweb-packer/dist/unpack.js',
          ),
        },
      ],
    },
    test: {
      globals: true,
    },
  }),
);
