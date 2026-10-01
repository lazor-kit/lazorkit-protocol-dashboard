// Public GitHub REST reads (unauthenticated) for the indexer workflow's state, so the site can say when GitHub
// disabled the schedule (it does so after 60 days without repository activity).

export interface WorkflowStatus {
  workflow_state: string;
  last_scheduled_run_at: string | null;
  last_conclusion: string | null;
  error: string | null;
}

export async function fetchWorkflowStatus(
  owner: string,
  repo: string,
  fetchImpl: typeof fetch = fetch,
  workflowFile = 'indexer.yml',
): Promise<WorkflowStatus> {
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${workflowFile}`;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'lazorkit-dashboard-heartbeat' };
  try {
    const workflow = await fetchImpl(base, { headers });
    if (!workflow.ok) {
      return { workflow_state: 'unknown', last_scheduled_run_at: null, last_conclusion: null, error: `workflow HTTP ${workflow.status}` };
    }
    const body = (await workflow.json()) as { state?: string };
    let lastRun: { created_at?: string; conclusion?: string | null } | undefined;
    const runs = await fetchImpl(`${base}/runs?per_page=1&event=schedule`, { headers });
    if (runs.ok) {
      const runsBody = (await runs.json()) as { workflow_runs?: Array<{ created_at?: string; conclusion?: string | null }> };
      lastRun = runsBody.workflow_runs?.[0];
    }
    return {
      workflow_state: typeof body.state === 'string' ? body.state : 'unknown',
      last_scheduled_run_at: lastRun?.created_at ?? null,
      last_conclusion: lastRun?.conclusion ?? null,
      error: runs.ok ? null : `runs HTTP ${runs.status}`,
    };
  } catch (error) {
    return {
      workflow_state: 'unknown',
      last_scheduled_run_at: null,
      last_conclusion: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
