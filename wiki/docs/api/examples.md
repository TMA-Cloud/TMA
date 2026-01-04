# API Examples

Code examples for TMA Cloud API.

## Authentication

### Login

```javascript
const response = await fetch("/api/login", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    email: "user@example.com",
    password: "password123",
  }),
  credentials: "include", // Important for cookies
});

const data = await response.json();
```

### Signup

```javascript
const response = await fetch("/api/signup", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    email: "user@example.com",
    password: "password123",
    name: "User Name",
  }),
  credentials: "include",
});

const data = await response.json();
```

## File Operations

### Upload File

```javascript
const formData = new FormData();
formData.append("file", fileInput.files[0]);
formData.append("parent_id", "folder_123");

const response = await fetch("/api/files/upload", {
  method: "POST",
  body: formData,
  credentials: "include",
});

const data = await response.json();
```

### List Files

```javascript
const response = await fetch(
  "/api/files?parentId=folder_123&sortBy=name&order=asc",
  {
    credentials: "include",
  },
);

const data = await response.json();
```

### Download File

```javascript
const response = await fetch("/api/files/file_123/download", {
  credentials: "include",
});

const blob = await response.blob();
const url = window.URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = url;
a.download = "file.pdf";
a.click();
```

## Share Links

### Create Share Link

```javascript
const response = await fetch("/api/files/share", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    ids: ["file_123", "file_456"],
    shared: true,
  }),
  credentials: "include",
});

const data = await response.json();
const shareUrl = data.data.shareLink;
```

## Error Handling

```javascript
try {
  const response = await fetch("/api/files", {
    credentials: "include",
  });

  const data = await response.json();

  if (!data.success) {
    switch (data.code) {
      case "UNAUTHORIZED":
        // Redirect to login
        break;
      case "STORAGE_LIMIT_EXCEEDED":
        // Show storage limit error
        break;
      default:
      // Show generic error
    }
  }
} catch (error) {
  // Handle network errors
}
```

## Related Topics

- [API Overview](overview.md) - API reference
- [Error Handling](errors.md) - Error codes
