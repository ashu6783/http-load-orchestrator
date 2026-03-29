export interface TestRow {
    id: string;
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers: string | null;
    payload: string | null;
    request_count: number;
    concurrency: number;
    status: string;
    created_at: string;
    completed_at: string | null;
    trace_id: string | null;
    last_checkpoint_at: string | null;
    completed_requests: number | null;
  }
  