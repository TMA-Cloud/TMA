import React, { useMemo, useRef } from 'react';
import { AlertTriangle, Clipboard, FileWarning } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useApp, type UploadFailure } from '../../contexts/AppContext';
import { useToast } from '../../hooks/useToast';
import { copyToClipboard } from '../../utils/clipboard';

/**
 * Long enough to see the shape of the problem, short enough that the dialog
 * still opens instantly after a 50,000-file folder went wrong.
 */
const MAX_ROWS_PER_REASON = 50;

type ReasonGroup = { reason: string; files: UploadFailure[] };

/**
 * Collapses the reasons that name the offending file inside themselves.
 * The server says ".mpeg does not match" and ".mp4 does not match" separately,
 * which would split one problem across a heading per extension — and the
 * extension is already visible in the file name underneath.
 */
function reasonHeading(reason: string): string {
  if (reason.startsWith('File content does not match extension')) return 'Content does not match the file extension';
  if (reason.startsWith('Invalid file name')) return 'File name is not allowed';
  return reason;
}

/**
 * Groups by reason, because that is the thing the user has to act on: one
 * heading saying 40 files did not match their extension is readable, and 40
 * separate lines saying the same thing are not.
 */
function groupByReason(failures: UploadFailure[]): ReasonGroup[] {
  const groups = new Map<string, UploadFailure[]>();
  for (const failure of failures) {
    const heading = reasonHeading(failure.reason);
    const existing = groups.get(heading);
    if (existing) existing.push(failure);
    else groups.set(heading, [failure]);
  }
  return [...groups.entries()]
    .map(([reason, files]) => ({ reason, files }))
    .sort((a, b) => b.files.length - a.files.length);
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * The outcome of an upload that partly failed, as a dialog the user dismisses
 * themselves.
 *
 * Rejections used to arrive as a toast each, so a folder upload could stack
 * several on top of one another and take the reasons away on a timer. What went
 * wrong and which files it happened to is worth an interruption that waits.
 */
export const UploadIssuesModal: React.FC = () => {
  const { uploadFailures, uploadSavedCount, dismissUploadFailures } = useApp();
  const { showToast } = useToast();
  const acknowledgeRef = useRef<HTMLButtonElement>(null);

  const groups = useMemo(() => groupByReason(uploadFailures), [uploadFailures]);

  if (uploadFailures.length === 0) return null;

  // The outcome first, then the one thing to do about it. A count out of the
  // run's total beats "the other files", which leaves the reader doing
  // arithmetic, and beats "these", which leaves them working out what it
  // refers to.
  const failedCount = uploadFailures.length;
  const many = failedCount > 1;
  const total = uploadSavedCount + failedCount;
  const summary =
    uploadSavedCount > 0
      ? `${uploadSavedCount.toLocaleString()} of ${total.toLocaleString()} files ${uploadSavedCount === 1 ? 'was' : 'were'} uploaded. ` +
        (many
          ? `Fix the ${failedCount.toLocaleString()} below and upload them again.`
          : 'Fix the one below and upload it again.')
      : many
        ? `None of the ${failedCount.toLocaleString()} files were uploaded. Fix the problems below and upload them again.`
        : 'This file was not uploaded. Fix the problem below and upload it again.';

  const copyDetails = async () => {
    const lines = groups.flatMap(group => [
      group.reason,
      ...group.files.map(f => `  ${f.folderPath ? `${f.folderPath}/` : ''}${f.fileName}`),
      '',
    ]);
    try {
      await copyToClipboard(lines.join('\n'));
      showToast('Details copied', 'success');
    } catch {
      showToast('Could not copy the details', 'error');
    }
  };

  return (
    <Modal
      isOpen
      onClose={dismissUploadFailures}
      title={`${plural(uploadFailures.length, 'file')} not uploaded`}
      size="lg"
      initialFocusRef={acknowledgeRef as React.RefObject<HTMLElement>}
    >
      <div className="space-y-5">
        <div className="flex gap-3 rounded-2xl bg-[var(--fill-quaternary)] p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--warning-text)]" strokeWidth={2.25} />
          <p className="type-callout text-[var(--label-secondary)]">{summary}</p>
        </div>

        {/* One scroller around every section, so the summary above it and the
            buttons below it hold their place however many files were refused. */}
        <div className="scroller max-h-[min(26rem,44vh)] space-y-4 overflow-y-auto">
          {groups.map(group => {
            const shown = group.files.slice(0, MAX_ROWS_PER_REASON);
            const hidden = group.files.length - shown.length;
            return (
              <section key={group.reason} className="space-y-2">
                <header className="flex items-baseline justify-between gap-3">
                  <h4 className="type-callout type-emphasized min-w-0 text-[var(--label)]">{group.reason}</h4>
                  <span className="type-caption shrink-0 text-[var(--label-tertiary)]">
                    {plural(group.files.length, 'file')}
                  </span>
                </header>

                <ul className="divide-y divide-[var(--separator)] overflow-hidden rounded-2xl bg-[var(--fill-quaternary)]">
                  {shown.map((failure, index) => (
                    <li
                      key={`${failure.folderPath ?? ''}/${failure.fileName}-${index}`}
                      className="flex items-center gap-3 px-3.5 py-2.5"
                    >
                      <FileWarning className="h-4 w-4 shrink-0 text-[var(--label-tertiary)]" strokeWidth={2} />
                      <div className="min-w-0">
                        <p className="type-footnote truncate text-[var(--label)]">{failure.fileName}</p>
                        {failure.folderPath && (
                          <p className="type-caption-2 truncate text-[var(--label-tertiary)]">{failure.folderPath}</p>
                        )}
                      </div>
                    </li>
                  ))}
                  {hidden > 0 && (
                    <li className="type-caption px-3.5 py-2.5 text-[var(--label-tertiary)]">
                      and {plural(hidden, 'more file')}
                    </li>
                  )}
                </ul>
              </section>
            );
          })}
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={copyDetails} className="btn btn-secondary type-callout">
            <Clipboard className="h-4 w-4" strokeWidth={2} />
            Copy details
          </button>
          <button ref={acknowledgeRef} type="button" onClick={dismissUploadFailures} className="btn btn-primary">
            Got it
          </button>
        </div>
      </div>
    </Modal>
  );
};
