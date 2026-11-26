export interface Stat {
  mean: number;
  sd: number;
}

export type MetricKey =
  | "duplicateExecutions"
  | "manualResets"
  | "erpDoubleBookings"
  | "leadP95Min"
  | "partitionLeadP95Min"
  | "latePct"
  | "leadP50Min"
  | "erpMissing"
  | "kbPerDay";

export interface DesignResult {
  design: string;
  label: string;
  seeds: number[];
  orders: Stat;
  metrics: Record<MetricKey, Stat>;
}

export interface Results {
  split: string;
  days: number;
  generatedBy: string;
  designs: DesignResult[];
}
