import { createApp } from "vue";

import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";

import App from "./App.vue";
import { router } from "./router.ts";
import "./style.css";

createApp(App).use(router).mount("#app");
