import notices from "../../../../../docs/legal/THIRD_PARTY_NOTICES.txt?raw";
export default function ThirdPartyNotices() {
  return <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: "50vh", overflow: "auto" }}>{notices}</pre>;
}
