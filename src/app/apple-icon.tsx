import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(135deg, #06B6D4 0%, #14B8A6 100%)",
          borderRadius: 40,
        }}
      >
        <svg width="112" height="112" viewBox="0 0 64 64" fill="none">
          <path
            d="M16 32h5m4 0h2m4-8v16m4-12v8m4-15v22m4-12v2m4-8v16m4-11h2m4 0h2"
            stroke="#F8FAFC"
            strokeWidth="3.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    ),
    { ...size },
  );
}
