import clsx from "clsx";
import Link from "@docusaurus/Link";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";
import Layout from "@theme/Layout";
import Heading from "@theme/Heading";
import styles from "./index.module.css";

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <header className={clsx("hero hero--primary", styles.heroBanner)}>
      <div className="container">
        <div className={styles.heroContent}>
          <Heading as="h1" className="hero__title">
            {siteConfig.title}
          </Heading>
          <p className="hero__subtitle">{siteConfig.tagline}</p>
          <p className={styles.heroDescription}>
            Technical documentation for TMA Cloud, a self-hosted file storage
            and sharing platform
          </p>
          <div className={styles.buttons}>
            <Link
              className="button button--secondary button--lg"
              to="/getting-started/overview"
            >
              Get Started →
            </Link>
            <Link
              className="button button--outline button--secondary button--lg"
              to="/api/overview"
            >
              API Reference
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}

interface FeatureCardProps {
  title: string;
  description: string;
  icon: string;
  to: string;
}

function FeatureCard({ title, description, icon, to }: FeatureCardProps) {
  return (
    <Link to={to} className={styles.featureCard}>
      <div className={styles.featureIcon}>{icon}</div>
      <div className={styles.featureContent}>
        <Heading as="h3" className={styles.featureTitle}>
          {title}
        </Heading>
        <p className={styles.featureDescription}>{description}</p>
      </div>
    </Link>
  );
}

function FeaturesSection() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className={styles.featuresHeader}>
          <Heading as="h2" className={styles.sectionTitle}>
            What TMA Cloud provides
          </Heading>
        </div>
        <div className={styles.featuresGrid}>
          <FeatureCard
            title="Authentication & Security"
            description="JWT-based authentication with optional OAuth and multi-factor authentication"
            icon="🔐"
            to="/concepts/authentication"
          />
          <FeatureCard
            title="File Management"
            description="Upload, organize, move, copy, and delete files and folders with a hierarchical structure"
            icon="📁"
            to="/guides/user/upload-files"
          />
          <FeatureCard
            title="Sharing & Collaboration"
            description="CPublic and private share links for files and folders, with optional expiration and custom domains"
            icon="🔗"
            to="/guides/user/share-files"
          />
          <FeatureCard
            title="Admin Controls"
            description="User management, signup control, storage limits, and custom drive configuration"
            icon="⚙️"
            to="/guides/admin/user-management"
          />
          <FeatureCard
            title="API Integration"
            description="REST API for automation and integration with external applications"
            icon="🔌"
            to="/api/overview"
          />
          <FeatureCard
            title="Audit & Monitoring"
            description="Structured application logs and audit events for tracking user actions and system activity"
            icon="📊"
            to="/guides/operations/audit-logs"
          />
        </div>
      </div>
    </section>
  );
}

function QuickStartSection() {
  return (
    <section className={styles.quickStart}>
      <div className="container">
        <div className={styles.quickStartContent}>
          <div className={styles.quickStartText}>
            <Heading as="h2" className={styles.sectionTitle}>
              Quick Start
            </Heading>
            <p className={styles.quickStartDescription}>
              Get up and running with TMA Cloud in minutes. Follow our
              step-by-step guide to deploy your own self-hosted cloud storage
              solution.
            </p>
            <div className={styles.quickStartSteps}>
              <div className={styles.step}>
                <div className={styles.stepNumber}>1</div>
                <div className={styles.stepContent}>
                  <Heading as="h3" className={styles.stepTitle}>
                    Installation
                  </Heading>
                  <p>Deploy TMA Cloud using Docker or a manual installation</p>
                </div>
              </div>
              <div className={styles.step}>
                <div className={styles.stepNumber}>2</div>
                <div className={styles.stepContent}>
                  <Heading as="h3" className={styles.stepTitle}>
                    Configuration
                  </Heading>
                  <p>
                    Set environment variables, database access, and optional
                    services
                  </p>
                </div>
              </div>
              <div className={styles.step}>
                <div className={styles.stepNumber}>3</div>
                <div className={styles.stepContent}>
                  <Heading as="h3" className={styles.stepTitle}>
                    Sign Up
                  </Heading>
                  <p>Create an account and start managing files</p>
                </div>
              </div>
            </div>
            <Link
              className="button button--primary button--lg"
              to="/getting-started/overview"
            >
              View Getting Started Guide →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function DocumentationLinks() {
  return (
    <section className={styles.docsLinks}>
      <div className="container">
        <Heading as="h2" className={styles.sectionTitle}>
          Explore Documentation
        </Heading>
        <div className={styles.docsGrid}>
          <Link to="/getting-started/overview" className={styles.docCard}>
            <div className={styles.docCardIcon}>🚀</div>
            <Heading as="h3" className={styles.docCardTitle}>
              Getting Started
            </Heading>
            <p className={styles.docCardDescription}>
              Installation, configuration, and initial setup
            </p>
          </Link>
          <Link to="/concepts/architecture" className={styles.docCard}>
            <div className={styles.docCardIcon}>🏗️</div>
            <Heading as="h3" className={styles.docCardTitle}>
              Concepts
            </Heading>
            <p className={styles.docCardDescription}>
              Architecture, authentication model, storage design, and security
              principles
            </p>
          </Link>
          <Link to="/guides/user/upload-files" className={styles.docCard}>
            <div className={styles.docCardIcon}>📖</div>
            <Heading as="h3" className={styles.docCardTitle}>
              User Guides
            </Heading>
            <p className={styles.docCardDescription}>
              How to perform common tasks such as uploading files, sharing
              content, and managing folders
            </p>
          </Link>
          <Link to="/api/overview" className={styles.docCard}>
            <div className={styles.docCardIcon}>🔧</div>
            <Heading as="h3" className={styles.docCardTitle}>
              API Reference
            </Heading>
            <p className={styles.docCardDescription}>
              Endpoint reference, authentication, request formats, and responses
            </p>
          </Link>
          <Link to="/debugging/overview" className={styles.docCard}>
            <div className={styles.docCardIcon}>🐛</div>
            <Heading as="h3" className={styles.docCardTitle}>
              Debugging
            </Heading>
            <p className={styles.docCardDescription}>
              Troubleshooting common problems and operational issues
            </p>
          </Link>
          <Link
            to="/reference/environment-variables"
            className={styles.docCard}
          >
            <div className={styles.docCardIcon}>📚</div>
            <Heading as="h3" className={styles.docCardTitle}>
              Reference
            </Heading>
            <p className={styles.docCardDescription}>
              Environment variables, database schema, audit events, and system
              limits
            </p>
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Home(): JSX.Element {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} - ${siteConfig.tagline}`}
      description="Documentation for TMA Cloud - A self-hosted cloud storage platform"
    >
      <HomepageHeader />
      <main>
        <FeaturesSection />
        <QuickStartSection />
        <DocumentationLinks />
      </main>
    </Layout>
  );
}
