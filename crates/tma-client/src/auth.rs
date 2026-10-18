//! Sign-in, the profile, sessions and two-factor authentication.

use serde_json::{Value, json};
use tma_core::api::{
    BackupCodes, ChangePasswordRequest, CountResponse, LoginRequest, MessageResponse, MfaEnabled, MfaSetup, MfaStatus,
    PublicSignupStatus, RevokeOthersResponse, SessionList, SignupRequest, User, UserEnvelope,
};

use crate::error::ApiResult;
use crate::http::{Client, enc};

impl Client {
    pub async fn login(&self, email: &str, password: &str, mfa_code: Option<&str>) -> ApiResult<User> {
        let body =
            LoginRequest { email: email.into(), password: password.into(), mfa_code: mfa_code.map(String::from) };
        Ok(self.post::<_, UserEnvelope>("/api/login", &body).await?.user)
    }

    pub async fn signup(&self, name: Option<&str>, email: &str, password: &str) -> ApiResult<User> {
        let body = SignupRequest { email: email.into(), password: password.into(), name: name.map(String::from) };
        Ok(self.post::<_, UserEnvelope>("/api/signup", &body).await?.user)
    }

    pub async fn logout(&self) -> ApiResult<()> {
        self.post::<_, Value>("/api/logout", &json!({})).await.map(|_| ())
    }

    pub async fn logout_all(&self) -> ApiResult<()> {
        self.post::<_, Value>("/api/logout-all", &json!({})).await.map(|_| ())
    }

    pub async fn profile(&self) -> ApiResult<User> {
        self.get("/api/profile").await
    }

    pub async fn change_password(&self, old: &str, new: &str, mfa_code: Option<&str>) -> ApiResult<MessageResponse> {
        let body = ChangePasswordRequest {
            old_password: old.into(),
            new_password: new.into(),
            mfa_code: mfa_code.map(String::from),
        };
        self.post("/api/change-password", &body).await
    }

    pub async fn public_signup_status(&self) -> ApiResult<PublicSignupStatus> {
        self.get("/api/signup-status").await
    }

    pub async fn sessions(&self, refresh_ip: bool) -> ApiResult<SessionList> {
        self.get(if refresh_ip { "/api/sessions?refreshIp=true" } else { "/api/sessions" }).await
    }

    pub async fn revoke_session(&self, id: &str) -> ApiResult<MessageResponse> {
        self.delete(&format!("/api/sessions/{}", enc(id))).await
    }

    pub async fn revoke_other_sessions(&self) -> ApiResult<RevokeOthersResponse> {
        self.post("/api/sessions/revoke-others", &json!({})).await
    }

    /// Presence for the web tab; the desktop app reports through `client_heartbeat`.
    pub async fn session_heartbeat(&self) -> ApiResult<()> {
        self.post::<_, Value>("/api/sessions/heartbeat", &json!({})).await.map(|_| ())
    }

    pub async fn mfa_status(&self) -> ApiResult<MfaStatus> {
        self.get("/api/mfa/status").await
    }

    pub async fn mfa_setup(&self) -> ApiResult<MfaSetup> {
        self.post("/api/mfa/setup", &json!({})).await
    }

    pub async fn mfa_verify(&self, code: &str) -> ApiResult<MfaEnabled> {
        self.post("/api/mfa/verify", &json!({ "code": code })).await
    }

    pub async fn mfa_disable(&self, code: &str) -> ApiResult<Value> {
        self.post("/api/mfa/disable", &json!({ "code": code })).await
    }

    pub async fn mfa_regenerate_codes(&self) -> ApiResult<BackupCodes> {
        self.post("/api/mfa/backup-codes/regenerate", &json!({})).await
    }

    pub async fn mfa_backup_count(&self) -> ApiResult<i64> {
        Ok(self.get::<CountResponse>("/api/mfa/backup-codes/count").await?.count)
    }
}
