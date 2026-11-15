// Oxlint registers one plugin name; this entry publishes every clients rule.
import { rule as boundaries } from "./boundaries.js";
import { rule as contentTypeExactEssence } from "./content-type-exact-essence.js";
import { rule as spawnTimeout } from "./spawn-timeout.js";
import { rule as unversionedPublic } from "./unversioned-public.js";

export default {
  meta: { name: "clients" },
  rules: {
    boundaries,
    "content-type-exact-essence": contentTypeExactEssence,
    "spawn-timeout": spawnTimeout,
    "unversioned-public": unversionedPublic,
  },
};
