// Limits remain the Docker runtime caps. Reservations only control placement.
export function resourceCapacitySql(node: string, cpu: string, memory: string) {
  const reservedMemory = (alias: string) => `(CASE WHEN ${alias}.memory_mb <= 1024 THEN 256 ELSE ${alias}.memory_mb / 2 END)`;
  const used = (resource: string) => `COALESCE((SELECT sum(${resource}) FROM sandboxes other
    WHERE other.compute_node_id = ${node} AND other.id <> sandboxes.id
      AND (other.state IN ('running', 'degraded') OR (other.state = 'provisioning' AND
        (other.runtime_id IS NOT NULL OR EXISTS (SELECT 1 FROM compute_jobs reservation
          WHERE reservation.sandbox_id = other.id AND reservation.status = 'leased'))))), 0)`;
  return `((${cpu} IS NULL OR sandboxes.cpu_count / 4.0 + ${used("other.cpu_count / 4.0")} <= ${cpu})
    AND (${memory} IS NULL OR ${reservedMemory("sandboxes")} + ${used(reservedMemory("other"))}
      <= ${memory} - GREATEST(512, CEIL(${memory} * 0.1))))`;
}

// Unknown capacity cannot establish a shortage. Include pinned environments and
// queued starts, and keep this calculation identical to job admission.
export const queueReasonSql = `CASE WHEN EXISTS (SELECT 1 FROM compute_jobs
    WHERE sandbox_id = sandboxes.id AND operation IN ('create', 'start') AND status = 'queued')
  AND (SELECT hosting_mode FROM organizations WHERE id = sandboxes.organization_id) = 'hybrid'
  AND EXISTS (SELECT 1 FROM compute_agents a WHERE a.organization_id = sandboxes.organization_id
    AND a.revoked_at IS NULL AND a.last_seen_at > now() - interval '60 seconds'
    AND (sandboxes.compute_node_id IS NULL OR sandboxes.compute_node_id = a.id))
  AND NOT EXISTS (SELECT 1 FROM compute_agents a WHERE a.organization_id = sandboxes.organization_id
    AND a.revoked_at IS NULL AND a.last_seen_at > now() - interval '60 seconds'
    AND (sandboxes.compute_node_id IS NULL OR sandboxes.compute_node_id = a.id)
    AND ${resourceCapacitySql("a.id", "a.cpu_count", "a.memory_mb")})
  THEN 'insufficient_capacity' ELSE NULL END`;
