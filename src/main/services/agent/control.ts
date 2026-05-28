/**
 * Agent Module - Generation Control
 *
 * Functions for controlling agent generation including:
 * - Stop/abort generation
 * - Check if generating
 * - Get active sessions
 * - Get session state for recovery
 */

import { activeSessions, v2Sessions, invalidateSession } from './session-manager';
import { getRemoteWsClient } from '../remote/ws/remote-ws-client';
import { rejectAllQuestions, rejectAllPermissions } from './permission-handler';
import type { Thought } from './types';

// ============================================
// Stop Generation
// ============================================

/**
 * Stop generation for a specific conversation or all conversations
 *
 * @param conversationId - Optional conversation ID. If not provided, stops all.
 */
export async function stopGeneration(conversationId?: string): Promise<void> {
  console.log(
    `[Agent][control.ts] stopGeneration called with conversationId=${conversationId || 'undefined'}`,
  );

  // Reject all pending AskUserQuestion and tool permission promises to unblock the SDK
  rejectAllQuestions();
  rejectAllPermissions();


  if (conversationId) {
    // Reject pending AskUserQuestion prompts only for this conversation.
    rejectAllQuestions(conversationId);

    // Stop specific session
    const session = activeSessions.get(conversationId);
    console.log(`[Agent][control.ts] Session found: ${!!session}`);

    if (session) {
      console.log(`[Agent][control.ts] Session isRemote=${(session as any).isRemote}`);

      try {
        console.log(`[Agent][control.ts] Calling abortController.abort()...`);
        session.abortController.abort();
        console.log(`[Agent][control.ts] abortController.abort() completed`);
      } catch (e) {
        console.error(`[Agent][control.ts] abortController.abort() error:`, e);
      }

      // Note: Don't delete from activeSessions here - let send-message.ts handle cleanup
      // after it persists content. The abort will trigger an AbortError in send-message.ts,
      // which will then call unregisterActiveSession() after saving content.

      // Interrupt V2 Session
      // SKIP for remote sessions - they don't have a local V2 session
      if (!(session as any).isRemote) {
        console.log(`[Agent][control.ts] Checking v2Sessions...`);
        const v2Session = v2Sessions.get(conversationId);
        console.log(`[Agent][control.ts] v2Session found: ${!!v2Session}`);
        if (v2Session) {
          try {
            if (typeof (v2Session.session as any).interrupt === 'function') {
              // Race interrupt against a timeout to prevent hanging.
              // NOTE: Do NOT drain messages here — the stream processor's for-await loop
              // in stream-processor.ts is already consuming from the same SDK stream.
              // A second iterator would steal messages, causing the stream processor to
              // hang forever and agent:complete to never be emitted.
              const INTERRUPT_TIMEOUT = 5000;
              await Promise.race([
                (v2Session.session as any).interrupt(),
                new Promise((_, reject) =>
                  setTimeout(
                    () => reject(new Error('V2 interrupt timed out')),
                    INTERRUPT_TIMEOUT,
                  ),
                ),
              ]);
              console.log(`[Agent] V2 session interrupted for: ${conversationId}`);
            } else {
              console.log(`[Agent] V2 session does not support interrupt(), skipping`);
            }
          } catch (e) {
            console.error(`[Agent] Failed to interrupt V2 session:`, e);
          }

          // Mark V2 session for recreation on next round.
          // After interrupt, the SDK subprocess's internal state may be inconsistent,
          // causing session replay to hang on the next sendMessage call.
          // getOrCreateV2Session() will detect this and create a fresh session.
          invalidateSession(conversationId);
          console.log(`[Agent] V2 session marked for recreation: ${conversationId}`);
        }
      } else {
        console.log(`[Agent][control.ts] Skipping v2Session handling for remote session`);
      }

      // Interrupt remote session if this is a remote space
      // Note: Client is registered with conversationId in send-message.ts
      // The: interrupt() now handles the delay and disconnect internally
      console.log(`[Agent][control.ts] Checking for remote client...`);
      try {
        const remoteClient = getRemoteWsClient(conversationId);
        console.log(`[Agent][control.ts] Remote client found: ${!!remoteClient}`);
        console.log(
          `[Agent][control.ts] Remote client isConnected: ${remoteClient?.isConnected()}`,
        );
        console.log(`[Agent][control.ts] Remote client isRemote: ${(session as any).isRemote}`);

        if (remoteClient) {
          // Send interrupt to remote server (handles reconnect if needed)
          // interrupt() now handles:
          // 1. Sending interrupt message to remote server
          // 2. Waiting 300ms for queued events to process
          // 3. Setting isInterrupted flag
          // 4. Disconnecting the client after delay
          console.log(`[Agent][control.ts] Sending interrupt to remote server...`)
          const interruptResult = await remoteClient.interrupt(conversationId);
          console.log(
            `[Agent] Remote session interrupted for: ${conversationId}, result=${interruptResult}`,
          );
          // Note: disconnect() is now called inside interrupt() after the delay
        } else {
          console.log(`[Agent][control.ts] Remote client not found`);
        }
      } catch (e) {
        console.error(`[Agent] Failed to interrupt remote session:`, e);
      }

      console.log(`[Agent] Stopped generation for conversation: ${conversationId}`);
    } else {
      console.log(
        `[Agent][control.ts] No active session found for conversationId=${conversationId}`,
      );
    }
  } else {
    // Reject all pending AskUserQuestion prompts when stopping everything.
    rejectAllQuestions();

    // Stop all sessions (backward compatibility)
    for (const [convId, session] of Array.from(activeSessions)) {
      session.abortController.abort();

      // Interrupt V2 Session
      const v2Session = v2Sessions.get(convId);
      if (v2Session) {
        try {
          if (typeof (v2Session.session as any).interrupt === 'function') {
            await (v2Session.session as any).interrupt();
          } else {
            console.log(`[Agent] V2 session does not support interrupt() for ${convId}, skipping`);
          }
        } catch (e) {
          console.error(`[Agent] Failed to interrupt V2 session ${convId}:`, e);
        }
      }

      // Interrupt remote session
      try {
        const remoteClient = getRemoteWsClient(convId);
        if (remoteClient && remoteClient.isConnected()) {
          await remoteClient.interrupt(convId);
          remoteClient.disconnect();
        }
      } catch (e) {
        console.error(`[Agent] Failed to interrupt remote session ${convId}:`, e);
      }

      console.log(`[Agent] Stopped generation for conversation: ${convId}`);
    }
    activeSessions.clear();
    console.log('[Agent] All generations stopped');
  }
}

// ============================================
// Generation Status
// ============================================

/**
 * Check if a conversation has an active generation
 */
export function isGenerating(conversationId: string): boolean {
  return activeSessions.has(conversationId);
}

/**
 * Get all active session conversation IDs
 */
export function getActiveSessions(): string[] {
  return Array.from(activeSessions.keys());
}

// ============================================
// Session State Recovery
// ============================================

/**
 * Get current session state for a conversation (for recovery after refresh)
 *
 * This is used by frontend to recover the current state when they
 * reconnect or refresh the page during an active generation.
 */
export function getSessionState(conversationId: string): {
  isActive: boolean;
  thoughts: Thought[];
  streamingContent?: string;
  spaceId?: string;
} {
  const session = activeSessions.get(conversationId);
  if (!session) {
    return { isActive: false, thoughts: [] };
  }
  return {
    isActive: true,
    thoughts: [...session.thoughts],
    streamingContent: session.streamingContent,
    spaceId: session.spaceId,
  };
}
