import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        // Without this, Vitest's default module transform breaks the AWS
        // SDK v3 clients' internal `require("./runtimeConfig")` (used to
        // pick the Node vs browser runtime config) with
        // "Cannot find module '././runtimeConfig'". Marking these as
        // external tells Vitest to let Node's native require/import
        // handle them untransformed, which is what they need. This isn't
        // a sandbox workaround — anyone running `pnpm test` in this
        // package hits the same error without it.
        external: [/@aws-sdk\//, /@smithy\//],
      },
    },
  },
});
