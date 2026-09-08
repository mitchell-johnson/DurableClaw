export interface UserPermission {
  user_id: string;
  resource_type: string;
  permission_type: "none" | "read" | "write";
}
