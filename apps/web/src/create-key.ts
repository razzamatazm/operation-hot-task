import type { CreateTaskInput } from "@loan-tasks/shared";

/* A Create sent again unchanged is a retry and keeps its key, so a server that
   already filed it hands the task back (#495). Anything else is a new task. */
export interface CreateAttempt {
  sent: string;
  key: string;
}

export const keyCreateAttempt = (last: CreateAttempt | null, payload: CreateTaskInput): CreateAttempt => {
  const sent = JSON.stringify({ ...payload, createKey: undefined });
  return last?.sent === sent ? last : { sent, key: crypto.randomUUID() };
};
