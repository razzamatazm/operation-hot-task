import { Request } from "express";
import { UserIdentity, UserRole } from "@loan-tasks/shared";

const parseRoles = (raw: string | undefined): UserRole[] => {
  if (!raw) {
    return ["LOAN_OFFICER"];
  }

  const allowed: UserRole[] = ["LOAN_OFFICER", "FILE_CHECKER", "ADMIN"];
  const parts = raw
    .split(",")
    .map((role) => role.trim().toUpperCase())
    .filter((role): role is UserRole => allowed.includes(role as UserRole));

  return parts.length > 0 ? parts : ["LOAN_OFFICER"];
};

export const getUserFromRequest = (req: Request): UserIdentity => {
  const id = String(req.header("x-user-id") ?? "local-user");
  const displayName = String(req.header("x-user-name") ?? "Local User");
  const roles = parseRoles(req.header("x-user-roles") ?? undefined);

  return { id, displayName, roles };
};
