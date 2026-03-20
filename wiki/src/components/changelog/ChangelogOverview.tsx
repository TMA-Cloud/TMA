import React, { useEffect, useMemo, useRef, useState } from "react";
import { chooseLatestByMajor, semverCompare } from "./changelogRepo";
import { useChangelogIndex, useChangelogRelease } from "./changelogHooks";

export function ChangelogOverview() {
  const DEFAULT_CHANGELOG_BASE_URL = "https://tma-cloud.github.io/changelog/";
  const [selectedVersionTag, setSelectedVersionTag] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState<boolean>(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  const {
    index,
    loading: loadingIndex,
    error: indexError,
  } = useChangelogIndex(DEFAULT_CHANGELOG_BASE_URL);

  const versionOptions = useMemo(() => {
    if (!index) return [];
    return [...index.versions].sort((a, b) =>
      semverCompare(b.version, a.version),
    );
  }, [index]);

  const preferredVersionTag = useMemo(() => {
    if (!index) return "";
    if (index.latest) {
      return (
        index.versions.find((v) => v.version === index.latest)?.tag ??
        index.versions[0]?.tag ??
        ""
      );
    }
    return index.versions[0]?.tag ?? "";
  }, [index]);

  const effectiveSelectedVersionTag = selectedVersionTag || preferredVersionTag;

  const selectedVersion = useMemo(() => {
    if (!versionOptions.length) return null;
    return (
      versionOptions.find((v) => v.tag === effectiveSelectedVersionTag) ||
      versionOptions[0]
    );
  }, [effectiveSelectedVersionTag, versionOptions]);

  const releaseFile = useMemo(() => {
    if (!index || !effectiveSelectedVersionTag) return null;
    return (
      index.versions.find((v) => v.tag === effectiveSelectedVersionTag)?.file ??
      null
    );
  }, [index, effectiveSelectedVersionTag]);

  const {
    release,
    loading: loadingRelease,
    error: releaseError,
  } = useChangelogRelease(DEFAULT_CHANGELOG_BASE_URL, releaseFile);

  const error = indexError || releaseError;

  useEffect(() => {
    if (!dropdownOpen) return;

    function onMouseDown(e: MouseEvent) {
      const el = dropdownRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setDropdownOpen(false);
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setDropdownOpen(false);
    }

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dropdownOpen]);

  return (
    <div className="changelogContainer">
      <h2>Changelog</h2>

      {error ? (
        <div style={{ color: "#ffb3b3", marginBottom: 16 }}>
          <strong>Error:</strong> {error}
        </div>
      ) : null}

      {loadingIndex ? <p>Loading changelog index...</p> : null}

      {index ? (
        <>
          <div style={{ marginBottom: 14 }}>
            <div className="changelogDropdownWrapper" ref={dropdownRef}>
              <button
                type="button"
                className="changelogDropdownButton"
                aria-expanded={dropdownOpen}
                onClick={() => setDropdownOpen((v) => !v)}
              >
                {selectedVersion ? (
                  <>
                    {selectedVersion.version}{" "}
                    {selectedVersion.channel
                      ? `(${selectedVersion.channel})`
                      : ""}
                  </>
                ) : (
                  ""
                )}
                <span className="changelogDropdownCaret" aria-hidden="true" />
              </button>

              {dropdownOpen ? (
                <div className="changelogDropdownMenu" role="listbox">
                  {versionOptions.map((v) => {
                    const active = v.tag === effectiveSelectedVersionTag;
                    return (
                      <div
                        key={v.tag}
                        role="option"
                        aria-selected={active}
                        className={`changelogDropdownItem${active ? " changelogDropdownItem--active" : ""}`}
                        onClick={() => {
                          setSelectedVersionTag(v.tag);
                          setDropdownOpen(false);
                        }}
                      >
                        {v.version} {v.channel ? `(${v.channel})` : ""}
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </div>

          {loadingRelease ? <p>Loading release...</p> : null}

          {release ? (
            <div>
              <h3 style={{ marginBottom: 10 }}>
                {release.tag}{" "}
                {release.channel ? (
                  <span style={{ opacity: 0.8 }}>{`(${release.channel})`}</span>
                ) : null}
              </h3>

              {release.intro ? (
                <p style={{ marginTop: 0 }}>{release.intro}</p>
              ) : null}

              <ul className="changelogList">
                {release.items.map((item, idx) => (
                  <li key={`${release.tag}-${idx}`}>{item}</li>
                ))}
              </ul>

              {release.spatialNotes ? (
                <div style={{ marginTop: 18 }}>
                  <h4 style={{ marginBottom: 6 }}>Spatial Notes</h4>
                  <div style={{ whiteSpace: "pre-wrap", opacity: 0.95 }}>
                    {release.spatialNotes}
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

export function ChangelogMajor({ major }: { major: number }) {
  const DEFAULT_CHANGELOG_BASE_URL = "https://tma-cloud.github.io/changelog/";

  const {
    index,
    loading: loadingIndex,
    error: indexError,
  } = useChangelogIndex(DEFAULT_CHANGELOG_BASE_URL);

  const latest = useMemo(() => {
    if (!index) return null;
    return chooseLatestByMajor(index, major);
  }, [index, major]);

  const releaseFile = latest?.file ?? null;

  const {
    release,
    loading: loadingRelease,
    error: releaseError,
  } = useChangelogRelease(DEFAULT_CHANGELOG_BASE_URL, releaseFile);

  const error = indexError || releaseError;

  return (
    <div className="changelogContainer">
      <h2>Changelog v{major}.x</h2>

      {error ? (
        <div style={{ color: "#ffb3b3", marginBottom: 16 }}>
          <strong>Error:</strong> {error}
        </div>
      ) : null}

      {loadingIndex ? <p>Loading changelog index...</p> : null}
      {loadingRelease ? <p>Loading release...</p> : null}

      {release ? (
        <div>
          <h3 style={{ marginBottom: 10 }}>
            {release.tag}{" "}
            {release.channel ? (
              <span style={{ opacity: 0.8 }}>{`(${release.channel})`}</span>
            ) : null}
          </h3>

          {release.intro ? (
            <p style={{ marginTop: 0 }}>{release.intro}</p>
          ) : null}

          <ul className="changelogList">
            {release.items.map((item, idx) => (
              <li key={`${release.tag}-${idx}`}>{item}</li>
            ))}
          </ul>

          {release.spatialNotes ? (
            <div style={{ marginTop: 18 }}>
              <h4 style={{ marginBottom: 6 }}>Spatial Notes</h4>
              <div style={{ whiteSpace: "pre-wrap", opacity: 0.95 }}>
                {release.spatialNotes}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
