import { Env } from '@/interfaces/env.interface';
import { initializeDb } from './database';
import { RequestInterface } from '@/interfaces/request.interface';

export async function injectDB(request: RequestInterface, env: Env) {
  request.db = initializeDb(env);
}
