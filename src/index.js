import { Router } from './router.js';

export default {
  async fetch(request, env, ctx) {
    const router = new Router(env);
    return router.handle(request);
  }
};
