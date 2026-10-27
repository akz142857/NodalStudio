import { useI18n } from "../../i18n";
import policyZh from "../../../../../docs/legal/PRIVACY.zh-CN.txt?raw";
import policyEn from "../../../../../docs/legal/PRIVACY.en.txt?raw";
import masPolicyZh from "../../../../../docs/legal/PRIVACY.mas.zh-CN.txt?raw";
import masPolicyEn from "../../../../../docs/legal/PRIVACY.mas.en.txt?raw";

export function PrivacyPolicy({ isMas }: { isMas: boolean }) {
  const { locale, t } = useI18n();
  const policy = isMas
    ? (locale === "zh-CN" ? masPolicyZh : masPolicyEn)
    : (locale === "zh-CN" ? policyZh : policyEn);
  return <section className="data-boundary" aria-label={t("submission.privacyPolicy")}>
    <h3>{t("submission.privacyPolicy")}</h3>
    <p>{isMas ? t("submission.masNoCloud") : t("submission.communityCloud")}</p>
    {policy.split("\n\n").filter(Boolean).map((text, index) => <p key={index} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{text}</p>)}
  </section>;
}
