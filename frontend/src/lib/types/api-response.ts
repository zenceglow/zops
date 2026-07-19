export interface ApiResultType<T> {
  code: number;
  message?: string;
  data?: T;
  success: boolean;
}

export interface ApiPageResultType<T> {
  total: number;
  records: T[];
}
