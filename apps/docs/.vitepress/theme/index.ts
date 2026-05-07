import DefaultTheme from "vitepress/theme";
import TryIt from "./TryIt.vue";

export default {
  ...DefaultTheme,
  enhanceApp({ app }: { app: any }) {
    app.component("TryIt", TryIt);
  },
};
