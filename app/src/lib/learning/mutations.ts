import type {
  LearningSharingMode,
  LocalLearningSettings,
} from "@openbot/shared/learning";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { learningKeys } from "./queries";

const FALLBACK = "Couldn't save your Learning settings. Try again.";

/** Who else's Bots use your Skills: only yours, everyone's, or the ones you open. */
export function setLearningSharingModeMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (mode: LearningSharingMode): Promise<void> => {
      await client("/api/settings/learning/mode", {
        method: "PUT",
        body: { mode },
        fallback: FALLBACK,
      });
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.personal }),
  });
}

/** Opens one of your Skills to every Bot, or closes it again. */
export function setLearnedSkillOpenMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      name: string;
      open: boolean;
    }): Promise<void> => {
      await client(
        `/api/settings/learning/skills/${encodeURIComponent(variables.name)}`,
        { method: "PUT", body: { open: variables.open }, fallback: FALLBACK },
      );
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: learningKeys.personal }),
  });
}

const LOCAL_FALLBACK = "Couldn't save the change to Automatic learning. Try again.";
const invalidateLocal = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({ queryKey: learningKeys.local });

/** Local mode: whether OpenBot learns, how often it reads new conversations, and which Bots it leaves out. */
export function saveLocalLearningSettingsMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    mutationFn: async (settings: LocalLearningSettings): Promise<void> => {
      await client("/api/admin/learning/local/settings", {
        method: "PUT",
        body: settings,
        fallback: LOCAL_FALLBACK,
      });
    },
    onSuccess: () => invalidateLocal(queryClient),
  });
}

/** Local mode: read new conversations now instead of waiting for the schedule. */
export function runLocalLearningMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (): Promise<void> => {
      await client("/api/admin/learning/local/run", {
        method: "POST",
        body: {},
        fallback: "Couldn't start the analysis. Try again.",
      });
    },
    onSuccess: () => invalidateLocal(queryClient),
  });
}

/** Local mode: put a proposed Skill into use, decline it, or stop using one. */
export function decideLocalSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      id: string;
      decision: "approve" | "decline" | "retire";
    }): Promise<void> => {
      await client(
        `/api/admin/learning/local/skills/${encodeURIComponent(variables.id)}/${variables.decision}`,
        { method: "POST", body: {}, fallback: LOCAL_FALLBACK },
      );
    },
    onSuccess: () => invalidateLocal(queryClient),
  });
}

/** Local mode: change a learned Skill's name, description or instructions. */
export function editLocalSkillMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (variables: {
      id: string;
      input: { name: string; description: string; instructions: string };
    }): Promise<void> => {
      await client(
        `/api/admin/learning/local/skills/${encodeURIComponent(variables.id)}`,
        { method: "PUT", body: variables.input, fallback: LOCAL_FALLBACK },
      );
    },
    onSuccess: () => invalidateLocal(queryClient),
  });
}
