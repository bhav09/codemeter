import * as vscode from 'vscode';
import { AttributionRecord } from '@codemeter/core';
import { AttributionRepository, EventRepository, ProjectRepository } from '@codemeter/database';

export async function reviewAttribution(): Promise<void> {
  const eventsRepo = new EventRepository();
  const attrRepo = new AttributionRepository();
  const projectRepo = new ProjectRepository();

  const now = Date.now();
  const startMs = now - 7 * 24 * 60 * 60 * 1000;
  const events = eventsRepo.getByTimeRange(startMs, now);
  const attrs = new Map(attrRepo.getAll().map(a => [a.eventId, a]));

  const candidates = events
    .map(e => ({ e, a: attrs.get(e.eventId) }))
    .filter(x => !x.a || x.a.projectKey === 'unattributed' || x.a.confidence < 0.7)
    .slice(0, 200);

  if (candidates.length === 0) {
    await vscode.window.showInformationMessage('CodeMeter: nothing to review (no unattributed/low-confidence events in last 7 days).');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    candidates.map(({ e, a }) => ({
      label: `${new Date(e.timestampMs).toLocaleString()}  $${(e.cost.totalCents / 100).toFixed(2)}  ${e.model}`,
      description: a ? `confidence ${(a.confidence * 100).toFixed(0)}% (${a.projectKey})` : 'no attribution',
      detail: `eventId: ${e.eventId}`,
      eventId: e.eventId
    })),
    { title: 'Review events', canPickMany: true, matchOnDescription: true, matchOnDetail: true }
  );

  if (!picked || picked.length === 0) return;

  const projects = projectRepo.getAll();
  const projectPick = await vscode.window.showQuickPick(
    projects.map(p => ({ label: p.displayName, description: p.gitRemote, project: p })),
    { title: 'Assign selected events to project' }
  );
  if (!projectPick) return;

  const target = projectPick.project;
  for (const p of picked) {
    const record: AttributionRecord = {
      eventId: p.eventId,
      projectKey: target.projectKey,
      confidence: 1.0,
      reason: 'Manual reassignment',
      timestampMs: now
    };
    attrRepo.create(record);
  }

  await vscode.window.showInformationMessage(`CodeMeter: reassigned ${picked.length} event(s) to ${target.displayName}.`);
}


