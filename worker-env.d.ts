// Bindings this project reads from `cloudflare:workers`. TypeScript merges this
// declaration with the base `Cloudflare.Env` shipped by @cloudflare/workers-types.
// `DB` is optional because .openai/hosting.json may leave `d1` unset, which is
// exactly the case getDb() reports at runtime.
declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
  }
}
