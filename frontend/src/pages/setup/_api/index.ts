import { get, post } from '../../../lib/api';

export type SetupStatus = {
  initialized: boolean;
  port: number;
  /** 安装时选定的界面语言；空串表示没指定、跟随浏览器。 */
  default_lang: string;
};

export function getSetupStatus() {
  return get<SetupStatus>('/setup/status');
}

export function completeSetup(secret: string, username: string, password: string) {
  return post<null>('/setup/complete', { secret, username, password });
}
