import { MAX_COMPUTER_FILE_BYTES } from "@openbot/shared/attachments";
import {
  IconChevronRight,
  IconDownload,
  IconFile,
  IconFolder,
  IconFolderPlus,
  IconTrash,
  IconUpload,
} from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useRef, useState } from "react";
import { BotSubpage } from "@/components/bot-profile/bot-subpage";
import { PageEmpty, PageRows } from "@/components/layout/page-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  deleteComputerFileMutationOptions,
  makeComputerFolderMutationOptions,
  uploadComputerFileMutationOptions,
} from "@/lib/computers/mutations";
import {
  type ComputerFileEntry,
  computerFileDownloadUrl,
  computerFolderQueryOptions,
} from "@/lib/computers/queries";
import { searchTextEntry } from "@/lib/search-text";
import { queryClient } from "@/query-client";

export const Route = createFileRoute("/_authed/_app/bots/$agentId/files")({
  // The open folder is in the address, so Back goes up a folder and a folder can be linked to.
  validateSearch: (search: Record<string, unknown>): { folder?: string } =>
    searchTextEntry("folder", search.folder),
  component: FilesPage,
});

const UPLOAD_MB = Math.round(MAX_COMPUTER_FILE_BYTES / (1024 * 1024));

function FilesPage() {
  const { agentId } = Route.useParams();
  return (
    <BotSubpage
      agentId={agentId}
      description="Upload files for this Bot to use, and download the files it saves on its computer."
      title="Files"
    >
      {(agent) => <BotFiles botId={agent.id} />}
    </BotSubpage>
  );
}

function nameOf(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function inFolder(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}

function sizeLabel(bytes: number | undefined): string {
  if (bytes === undefined) return "File";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Folders first, then files, each by name. */
function sorted(entries: ComputerFileEntry[]): ComputerFileEntry[] {
  return [...entries].sort((a, b) =>
    a.kind === b.kind
      ? nameOf(a.path).localeCompare(nameOf(b.path))
      : a.kind === "folder"
        ? -1
        : 1,
  );
}

function BotFiles({ botId }: { botId: string }) {
  const { folder = "" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const listing = useQuery(computerFolderQueryOptions(botId, folder));
  const upload = useMutation(uploadComputerFileMutationOptions(queryClient));
  const remove = useMutation(deleteComputerFileMutationOptions(queryClient));
  const makeFolder = useMutation(
    makeComputerFolderMutationOptions(queryClient),
  );

  const picker = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<ComputerFileEntry | null>(null);
  const [naming, setNaming] = useState(false);
  const [folderName, setFolderName] = useState("");

  const open = (path: string) =>
    void navigate({ search: path ? { folder: path } : {} });

  const uploadAll = async (files: File[]) => {
    setProblem(null);
    for (const file of files) {
      if (file.size > MAX_COMPUTER_FILE_BYTES) {
        setProblem(
          `${file.name} is larger than ${UPLOAD_MB} MB, so it wasn't uploaded.`,
        );
        continue;
      }
      setUploading(file.name);
      try {
        await upload.mutateAsync({
          botId,
          path: inFolder(folder, file.name),
          file,
        });
      } catch (error) {
        setProblem(
          error instanceof Error
            ? `${file.name}: ${error.message}`
            : `Couldn't upload ${file.name}. Try again.`,
        );
      }
    }
    setUploading(null);
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setProblem(null);
    try {
      await remove.mutateAsync({ botId, path: deleting.path });
      setDeleting(null);
    } catch (error) {
      setDeleting(null);
      setProblem(
        error instanceof Error ? error.message : "Couldn't delete that.",
      );
    }
  };

  const createFolder = async () => {
    const name = folderName.trim();
    if (!name) return;
    setProblem(null);
    try {
      await makeFolder.mutateAsync({ botId, path: inFolder(folder, name) });
      setNaming(false);
      setFolderName("");
      open(inFolder(folder, name));
    } catch (error) {
      setProblem(
        error instanceof Error ? error.message : "Couldn't make that folder.",
      );
    }
  };

  const crumbs = folder ? folder.split("/").filter(Boolean) : [];
  const entries = listing.data ? sorted(listing.data.entries) : [];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for a mouse drag only; the Upload button does the same from the keyboard.
    <div
      className={dragging ? "rounded-lg ring-2 ring-primary/40" : undefined}
      onDragLeave={() => setDragging(false)}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void uploadAll(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav
          aria-label="Folder"
          className="flex min-w-0 flex-wrap items-center gap-1 text-sm"
        >
          <Button onClick={() => open("")} size="sm" variant="ghost">
            Home
          </Button>
          {crumbs.map((part, index) => {
            const path = crumbs.slice(0, index + 1).join("/");
            return (
              <Fragment key={path}>
                <IconChevronRight className="size-3.5 text-muted-foreground" />
                <Button onClick={() => open(path)} size="sm" variant="ghost">
                  {part}
                </Button>
              </Fragment>
            );
          })}
        </nav>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              setFolderName("");
              setNaming(true);
            }}
            size="sm"
            variant="outline"
          >
            <IconFolderPlus data-icon="inline-start" />
            New folder
          </Button>
          <Button
            disabled={uploading !== null}
            onClick={() => picker.current?.click()}
            size="sm"
          >
            <IconUpload data-icon="inline-start" />
            {uploading ? "Uploading…" : "Upload"}
          </Button>
          <input
            className="hidden"
            multiple
            onChange={(event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              void uploadAll(files);
            }}
            ref={picker}
            type="file"
          />
        </div>
      </div>

      {problem ? (
        <p className="mt-3 text-destructive text-sm" role="alert">
          {problem}
        </p>
      ) : null}
      {uploading ? (
        <p className="mt-3 text-muted-foreground text-sm" role="status">
          Uploading {uploading}…
        </p>
      ) : null}

      {listing.isPending ? null : listing.error ? (
        <p className="mt-4 text-destructive text-sm" role="alert">
          {listing.error.message} Reload the page to try again.
        </p>
      ) : entries.length === 0 ? (
        <PageEmpty
          action={
            <Button onClick={() => picker.current?.click()} size="sm">
              <IconUpload data-icon="inline-start" />
              Upload
            </Button>
          }
          icon={IconFolder}
          title={folder ? "This folder is empty" : "No files yet"}
        >
          Drop files here, or upload them. Files the Bot saves appear here too.
        </PageEmpty>
      ) : (
        <PageRows>
          {entries.map((entry, index) => (
            <Fragment key={entry.path}>
              {index > 0 ? <Separator /> : null}
              <Item size="sm">
                <ItemMedia variant="icon">
                  {entry.kind === "folder" ? <IconFolder /> : <IconFile />}
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>
                    {entry.kind === "folder" ? (
                      <button
                        className="text-left hover:underline"
                        onClick={() => open(entry.path)}
                        type="button"
                      >
                        {nameOf(entry.path)}
                      </button>
                    ) : (
                      <a
                        className="hover:underline"
                        download
                        href={computerFileDownloadUrl(botId, entry.path)}
                      >
                        {nameOf(entry.path)}
                      </a>
                    )}
                  </ItemTitle>
                  <ItemDescription>
                    {entry.kind === "folder"
                      ? "Folder"
                      : sizeLabel(entry.bytes)}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  {entry.kind === "file" ? (
                    <a
                      aria-label={`Download ${nameOf(entry.path)}`}
                      className={buttonVariants({
                        size: "icon-sm",
                        variant: "ghost",
                      })}
                      download
                      href={computerFileDownloadUrl(botId, entry.path)}
                    >
                      <IconDownload />
                    </a>
                  ) : null}
                  <Button
                    aria-label={`Delete ${nameOf(entry.path)}`}
                    onClick={() => setDeleting(entry)}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <IconTrash />
                  </Button>
                  {entry.kind === "folder" ? (
                    <Button
                      aria-label={`Open ${nameOf(entry.path)}`}
                      onClick={() => open(entry.path)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <IconChevronRight />
                    </Button>
                  ) : null}
                </ItemActions>
              </Item>
            </Fragment>
          ))}
        </PageRows>
      )}
      {listing.data?.truncated ? (
        <p className="mt-3 text-muted-foreground text-sm">
          This folder has more files than can be shown here.
        </p>
      ) : null}

      <Dialog
        onOpenChange={(isOpen) => {
          if (!isOpen) setDeleting(null);
        }}
        open={deleting !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {deleting ? nameOf(deleting.path) : ""}?
            </DialogTitle>
            <DialogDescription>
              {deleting?.kind === "folder"
                ? "The folder and everything in it are deleted from this Bot's computer."
                : "The file is deleted from this Bot's computer."}{" "}
              You can't undo this.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="mt-4">
            <Button onClick={() => setDeleting(null)} size="sm" variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={remove.isPending}
              onClick={() => void confirmDelete()}
              size="sm"
              variant="destructive"
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setNaming} open={naming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              {folder
                ? `The folder is made inside ${nameOf(folder)}.`
                : "The folder is made in this Bot's home folder."}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="mt-4">
            <form
              id="new-folder"
              onSubmit={(event) => {
                event.preventDefault();
                void createFolder();
              }}
            >
              <Input
                aria-label="Folder name"
                autoFocus
                onChange={(event) => setFolderName(event.target.value)}
                placeholder="ims-manual"
                value={folderName}
              />
            </form>
          </DialogBody>
          <DialogFooter className="mt-4">
            <Button
              onClick={() => setNaming(false)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={!folderName.trim() || makeFolder.isPending}
              form="new-folder"
              size="sm"
              type="submit"
            >
              {makeFolder.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
