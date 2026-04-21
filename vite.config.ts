import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  plugins: [react(), nitro()],
});
