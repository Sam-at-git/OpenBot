import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { clearActivity } from "./activity";
import { type ActionPolicy, computerKeys } from "./queries";

/**
 * Stopping frees the container; resetting also deletes the browser profiles on it; updating moves
 * the computer onto the current image and keeps the profiles.
 */
export type ComputerAction = "stop" | "reset" | "update";

const PAST: Record<ComputerAction, string> = {
  stop: "stopped",
  reset: "reset",
  update: "updated",
};

function invalidateComputers(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: computerKeys.all });
}

/**
 * An administrator stopping, resetting or updating one computer from the list.
 *
 * Named by whose computer it is, not by a Bot: the computer on the list is somebody else's, and the
 * Bot routes act on the asker's own. `botId` names one seat on a shared computer.
 */
export function setComputerStateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      computer: string;
      botId?: string;
      action: ComputerAction;
    }) => {
      await client("/api/computers/fleet", {
        method: "POST",
        body: {
          action: variables.action,
          computer: variables.computer,
          ...(variables.botId ? { botId: variables.botId } : {}),
        },
        fallback: `The computer could not be ${PAST[variables.action]}.`,
      });
    },
    /** A reset deletes the profile those commands ran on; a stop keeps it, so only reset forgets. */
    onSuccess: (_result, variables) => {
      if (variables.action === "reset" && variables.botId)
        clearActivity(variables.botId);
      return invalidateComputers(queryClient);
    },
  });
}

/**
 * Replace the whole policy.
 *
 * A PUT rather than a patch because the rules are ordered and evaluated as a set: sending a
 * difference would leave the server deciding where a new rule belongs, and where a deny sits
 * relative to an allow is most of what a policy means.
 */
export function saveActionPolicyMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: (next: ActionPolicy): Promise<ActionPolicy> =>
      client("/api/computers/policy", "policy", {
        method: "PUT",
        body: next,
        fallback: "The boundary could not be saved.",
      }),
    onSuccess: () => invalidateComputers(queryClient),
  });
}

const SECRET_FALLBACK = "Couldn't save the computer secret. Try again.";

/** Add a computer secret, or replace the value of the one with the same name and Bot. */
export function putComputerSecretMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (input: {
      name: string;
      value: string;
      agentId: string | null;
    }): Promise<void> => {
      await client("/api/admin/computer-secrets", {
        method: "PUT",
        body: input,
        fallback: SECRET_FALLBACK,
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: computerKeys.secrets() }),
  });
}

export function deleteComputerSecretMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (id: string): Promise<void> => {
      await client(`/api/admin/computer-secrets/${encodeURIComponent(id)}`, {
        method: "DELETE",
        fallback: "Couldn't remove the computer secret. Try again.",
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: computerKeys.secrets() }),
  });
}

const FILES_FALLBACK = "Couldn't change this Bot's files. Try again.";

function filesPath(botId: string, action: "upload" | "delete" | "folder") {
  return `/api/computers/${encodeURIComponent(botId)}/files/${action}`;
}

/** A file's bytes as base64, in slices so a large file does not overflow the argument list. */
export async function fileAsBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(binary);
}

/** A person putting one of their own files into a Bot's computer, at `path` from its home folder. */
export function uploadComputerFileMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      path: string;
      file: Blob;
    }): Promise<void> => {
      await client(filesPath(variables.botId, "upload"), {
        method: "POST",
        body: {
          path: variables.path,
          base64: await fileAsBase64(variables.file),
        },
        fallback: "Couldn't upload that file. Try again.",
      });
    },
    onSuccess: (_result, variables) =>
      queryClient.invalidateQueries({
        queryKey: computerKeys.files(variables.botId),
      }),
  });
}

/** Deleting a file, or a folder with everything in it. */
export function deleteComputerFileMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      path: string;
    }): Promise<void> => {
      await client(filesPath(variables.botId, "delete"), {
        method: "POST",
        body: { path: variables.path },
        fallback: FILES_FALLBACK,
      });
    },
    onSuccess: (_result, variables) =>
      queryClient.invalidateQueries({
        queryKey: computerKeys.files(variables.botId),
      }),
  });
}

export function makeComputerFolderMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      botId: string;
      path: string;
    }): Promise<void> => {
      await client(filesPath(variables.botId, "folder"), {
        method: "POST",
        body: { path: variables.path },
        fallback: FILES_FALLBACK,
      });
    },
    onSuccess: (_result, variables) =>
      queryClient.invalidateQueries({
        queryKey: computerKeys.files(variables.botId),
      }),
  });
}
