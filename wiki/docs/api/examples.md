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

### Bulk Download Files

```javascript
const response = await fetch("/api/files/download/bulk", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    ids: ["file_123", "file_456", "folder_789"],
  }),
  credentials: "include",
});

const blob = await response.blob();
const url = window.URL.createObjectURL(blob);
const a = document.createElement("a");
a.href = url;
a.download = "download.zip";
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
const shareUrl = data.links["file_123"];
```

## Error Handling

```javascript
try {
  const response = await fetch("/api/files/some_file_id", {
    credentials: "include",
  });

  if (!response.ok) {
    const errorData = await response.json();
    // Handle specific HTTP status codes
    switch (response.status) {
      case 401:
        // Unauthorized: Redirect to login
        break;
      case 403:
        // Forbidden: Show permission error
        break;
      case 422:
        // Validation error: Show specific field errors
        console.error("Validation failed:", errorData.details);
        break;
      default:
        // Show generic error from the 'message' field
        console.error(errorData.message);
    }
  } else {
    const data = await response.json();
    // Process successful response
  }
} catch (error) {
  // Handle network errors (e.g., failed to fetch)
  console.error("Network error:", error);
}
```

## Related Topics

- [API Overview](overview.md) - API reference
- [Error Handling](errors.md) - Error codes
