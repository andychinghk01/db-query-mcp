declare module "pg" {
  export class Client {
    constructor(options: {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
      connectionTimeoutMillis: number;
      query_timeout: number;
      statement_timeout: number;
    });
    connect(): Promise<void>;
    query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    end(): Promise<void>;
  }
  const pg: { Client: typeof Client };
  export default pg;
}
