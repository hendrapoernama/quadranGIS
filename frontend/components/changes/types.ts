export type CsStatus = 'draft' | 'submitted' | 'approved' | 'released' | 'rejected' | 'cancelled';

export interface Changeset {
  id: number;
  title: string;
  description: string;
  status: CsStatus;
  source: 'editor' | 'import';
  created_by: string | null;
  created_by_name: string;
  submitted_at: string | null;
  submitted_by: string;
  reviewed_at: string | null;
  reviewed_by: string;
  review_note: string;
  released_at: string | null;
  released_by: string;
  release_note: string;
  applied: number;
  failed: number;
  created_at: string;
  updated_at: string;
  counts: Record<string, number>;
  items: number;
}

export interface ChangeItem {
  id: number;
  changeset_id: number;
  seq: number;
  op: 'create' | 'update' | 'delete' | 'split' | 'merge';
  kind: 'node' | 'edge';
  target_id: number | null;
  type_code: string;
  code: string;
  name: string;
  body: any;
  before?: any;
  target_updated_at: string | null;
  status: 'pending' | 'applied' | 'failed';
  result_id: number | null;
  error: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  changes?: string[];
}

export interface ChangeLog {
  action: string;
  username: string;
  full_name: string;
  role: string;
  note: string;
  at: string;
}

export interface Conflict {
  item_id: number;
  kind: string;
  target_id: number;
  code: string;
  reason: string;
}

export const STATUS_TONE: Record<CsStatus, 'gray' | 'amber' | 'blue' | 'green' | 'red' | 'purple'> = {
  draft: 'gray',
  submitted: 'amber',
  approved: 'blue',
  released: 'green',
  rejected: 'red',
  cancelled: 'gray',
};

export const OP_TONE: Record<string, 'green' | 'blue' | 'red' | 'purple'> = { create: 'green', update: 'blue', delete: 'red', split: 'purple', merge: 'purple' };

/** id objek untuk dipilih di peta: objek baru (usulan) memakai id negatif. */
export const itemFeatureId = (it: ChangeItem) => (it.op === 'create' ? -it.id : it.target_id || 0);
