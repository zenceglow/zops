import { get, post } from '../../../lib/api';

export type SetupStatus = {
  initialized: boolean;
  port: number;
};

export function getSetupStatus() {
  return get<SetupStatus>('/setup/status');
}

export function completeSetup(secret: string, username: string, password: string) {
  return post<null>('/setup/complete', { secret, username, password });
}
