import { UserIdentity } from "@loan-tasks/shared";

export const mockUsers: UserIdentity[] = [
  {
    id: "loan-officer-1",
    displayName: "Suzie",
    roles: ["LOAN_OFFICER"]
  },
  {
    id: "file-checker-1",
    displayName: "Alexa",
    roles: ["LOAN_OFFICER", "FILE_CHECKER"]
  },
  {
    id: "admin-1",
    displayName: "Johanna",
    roles: ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"]
  }
];
