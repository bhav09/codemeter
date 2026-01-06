import { UsageEvent, ProjectSession, AttributionRecord, AttributionResult } from './types';

export class AttributionEngine {
  private readonly confidenceThresholds = {
    high: 0.9,
    medium: 0.7,
    low: 0.5
  };

  attributeEvent(
    event: UsageEvent,
    sessions: ProjectSession[]
  ): AttributionResult {
    const activeSessions = this.findActiveSessions(event.timestampMs, sessions);
    
    if (activeSessions.length === 0) {
      return this.createUnattributedResult(event, 'No active sessions');
    }

    const focusedSessions = activeSessions.filter(s => s.focused);
    const nonIdleSessions = focusedSessions.filter(s => !s.idle);

    if (nonIdleSessions.length === 1) {
      return this.createAttributionResult(event, nonIdleSessions[0], 1.0, 'Single focused, non-idle session');
    }

    if (focusedSessions.length === 1) {
      return this.createAttributionResult(event, focusedSessions[0], 0.9, 'Single focused session');
    }

    if (activeSessions.length === 1) {
      return this.createAttributionResult(event, activeSessions[0], 0.7, 'Single active session');
    }

    if (focusedSessions.length > 1) {
      return this.createConflictResult(event, focusedSessions, 'Multiple focused sessions');
    }

    return this.createConflictResult(event, activeSessions, 'Multiple active sessions');
  }

  private findActiveSessions(timestampMs: number, sessions: ProjectSession[]): ProjectSession[] {
    return sessions.filter(session => 
      session.startMs <= timestampMs && 
      (!session.endMs || session.endMs >= timestampMs)
    );
  }

  private createAttributionResult(
    event: UsageEvent,
    session: ProjectSession,
    confidence: number,
    reason: string
  ): AttributionResult {
    const attribution: AttributionRecord = {
      eventId: event.eventId,
      projectKey: session.projectKey,
      confidence,
      reason,
      timestampMs: event.timestampMs
    };

    return {
      event,
      attribution,
      confidence,
      conflicts: []
    };
  }

  private createUnattributedResult(event: UsageEvent, reason: string): AttributionResult {
    const attribution: AttributionRecord = {
      eventId: event.eventId,
      projectKey: 'unattributed',
      confidence: 0,
      reason,
      timestampMs: event.timestampMs
    };

    return {
      event,
      attribution,
      confidence: 0,
      conflicts: []
    };
  }

  private createConflictResult(
    event: UsageEvent,
    conflicts: ProjectSession[],
    reason: string
  ): AttributionResult {
    const primarySession = conflicts[0];
    const confidence = 0.5 / conflicts.length;

    const attribution: AttributionRecord = {
      eventId: event.eventId,
      projectKey: primarySession.projectKey,
      confidence,
      reason: `${reason} - using primary session`,
      timestampMs: event.timestampMs
    };

    return {
      event,
      attribution,
      confidence,
      conflicts
    };
  }
}
