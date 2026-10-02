// Placeholder owned by the `funding` lane, which replaces it with the real module.
import type { RouteModule } from "../../contracts/app.js";

export const fundingModule: RouteModule = {
  name: "funding",
  async register() {},
};
