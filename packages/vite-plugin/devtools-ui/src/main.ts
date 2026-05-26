import { createApp } from "vue";

import App from "./App.vue";
import { router } from "./router.ts";
import "./style.css";

createApp(App).use(router).mount("#app");
