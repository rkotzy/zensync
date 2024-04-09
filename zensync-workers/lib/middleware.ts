import { Env } from '@/interfaces/env.interface';
import { initializeDb } from './database';

export async function injectDB(request, env: Env) {
  request.db = initializeDb(env);
}
