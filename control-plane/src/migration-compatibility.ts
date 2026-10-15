// This correction removes the old account-specific admin grant. Existing
// installations retain their recorded migration and admin assignments.
export function compatibleMigrationChecksum(name: string, applied: string, current: string): boolean {
  return name === "0012_platform_admin_flag.sql"
    && applied === "715d15700d48762f6b6fc6240be5884ce6c7a22372052283417b38d4141c1379"
    && current === "301178580a25534ee3e89888a4f5ab5f20d5e7e58e7cad8338657bfd9d250f5d";
}
