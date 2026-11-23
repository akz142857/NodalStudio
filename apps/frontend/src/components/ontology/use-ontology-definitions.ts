import { useQuery } from "@tanstack/react-query";
import type { NodalStudioPlatform } from "../../platform";
import { ontologyDefinitionsKey, type OntologyScope } from "../../platform/ontology-types";

export function useOntologyDefinitions(platform: NodalStudioPlatform, scope?: OntologyScope) {
  return useQuery({
    queryKey: scope ? ontologyDefinitionsKey(scope) : ["ontology-definitions", "inactive"],
    queryFn: () => scope ? platform.listOntology(scope) : Promise.resolve([]),
    enabled: Boolean(scope),
    retry: false,
  });
}
