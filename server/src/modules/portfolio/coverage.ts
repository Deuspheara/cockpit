export interface ValuationIssue {
  code: string;
  accountId?: string;
  assetId?: string;
  name: string;
  network?: string;
  contractAddress?: string;
  quotedAt?: string;
  message: string;
  retryable: boolean;
  retryAction?: "sync" | "fx" | "history";
}
export interface Coverage {
  valued: string[];
  missing: ValuationIssue[];
}
