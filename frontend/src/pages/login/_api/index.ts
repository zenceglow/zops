import { login as loginRequest } from '../../../lib/api';

export async function login(username: string, password: string): Promise<string> {
  return loginRequest(username, password);
}
