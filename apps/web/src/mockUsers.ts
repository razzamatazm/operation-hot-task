import { UserIdentity } from "@loan-tasks/shared";

export const mockUsers: UserIdentity[] = [
  {
    id: "loan-officer-1",
    displayName: "Jamie Loan Officer",
    roles: ["LOAN_OFFICER"]
  },
  {
    id: "file-checker-1",
    displayName: "Taylor File Checker",
    roles: ["LOAN_OFFICER", "FILE_CHECKER"]
  },
  {
    id: "admin-1",
    displayName: "Morgan Admin",
    roles: ["LOAN_OFFICER", "ADMIN"]
  }
];
